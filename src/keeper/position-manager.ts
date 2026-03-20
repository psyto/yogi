import {
  DriftClient,
  PositionDirection,
  OrderType,
  MarketType,
  PostOnlyParams,
  BN,
} from "@drift-labs/sdk";
import { STRATEGY_CONFIG } from "../config/vault";
import {
  BASE_PRECISION,
  PRICE_PRECISION,
  USDC_DECIMALS,
} from "../config/constants";
import { FundingRateData } from "./funding-scanner";

export interface BasisPosition {
  marketIndex: number;
  marketName: string;
  direction: "short" | "long";
  sizeUsd: number;
  entryFundingRate: number;
  entryTimestamp: number;
}

export interface PortfolioState {
  totalEquity: number;
  lendingAllocation: number;
  basisAllocation: number;
  positions: BasisPosition[];
  unrealizedPnl: number;
}

export function computeTargetAllocations(
  totalEquity: number,
  rankedMarkets: FundingRateData[],
  currentPositions: BasisPosition[]
): {
  lendingTarget: number;
  basisTargets: { marketIndex: number; marketName: string; sizeUsd: number }[];
} {
  const { lendingFloorPct, basisTradePct, maxMarketsSimultaneous, maxPositionPctPerMarket } =
    STRATEGY_CONFIG;

  const lendingTarget = (totalEquity * lendingFloorPct) / 100;
  const basisBudget = (totalEquity * basisTradePct) / 100;

  // Select top N markets
  const selectedMarkets = rankedMarkets.slice(0, maxMarketsSimultaneous);
  if (selectedMarkets.length === 0) {
    // No good markets — put everything in lending
    return { lendingTarget: totalEquity, basisTargets: [] };
  }

  // Weight allocation by annualized funding rate
  const totalScore = selectedMarkets.reduce(
    (sum, m) => sum + m.annualizedPct,
    0
  );

  const basisTargets = selectedMarkets.map((market) => {
    const weight = market.annualizedPct / totalScore;
    const rawAllocation = basisBudget * weight;
    const maxAllocation = (totalEquity * maxPositionPctPerMarket) / 100;
    const sizeUsd = Math.min(rawAllocation, maxAllocation);

    return {
      marketIndex: market.marketIndex,
      marketName: market.market,
      sizeUsd,
    };
  });

  return { lendingTarget, basisTargets };
}

/**
 * Open a basis position using LIMIT orders (maker) when possible.
 *
 * Addresses the critique: "Repeating Taker executions ensures all alpha
 * is absorbed by the exchange."
 *
 * Maker fees on Drift: -0.002% (REBATE) vs Taker: 0.035% (PAY)
 * This transforms the fee structure from a 0.17% round-trip cost
 * to a ~0.004% round-trip INCOME.
 */
export async function openBasisPosition(
  driftClient: DriftClient,
  marketIndex: number,
  sizeUsd: number,
  direction: "short" | "long" = "short"
): Promise<string> {
  const oraclePrice = driftClient.getOracleDataForPerpMarket(marketIndex);
  const price = oraclePrice.price.toNumber() / PRICE_PRECISION;
  if (price <= 0 || !isFinite(price)) {
    throw new Error(`Invalid oracle price for market ${marketIndex}: ${price}`);
  }
  if (sizeUsd <= 0) {
    throw new Error(`Invalid position size: $${sizeUsd}`);
  }
  const baseAmount = (sizeUsd / price) * BASE_PRECISION;

  const perpDirection =
    direction === "short" ? PositionDirection.SHORT : PositionDirection.LONG;

  if (STRATEGY_CONFIG.useLimitOrders) {
    // SHORT: place above oracle (willing to sell higher)
    // LONG: place below oracle (willing to buy lower)
    const spreadSign = direction === "short" ? 1 : -1;
    const spreadMultiplier = 1 + spreadSign * (STRATEGY_CONFIG.limitOrderSpreadBps / 10000);
    const limitPrice = Math.floor(price * spreadMultiplier * PRICE_PRECISION);

    const orderParams = {
      orderType: OrderType.LIMIT,
      marketType: MarketType.PERP,
      marketIndex,
      direction: perpDirection,
      baseAssetAmount: new BN(Math.floor(baseAmount)),
      price: new BN(limitPrice),
      reduceOnly: false,
      postOnly: PostOnlyParams.MUST_POST_ONLY,
    };

    const txSig = await driftClient.placePerpOrder(orderParams);
    console.log(
      `Opened ${direction.toUpperCase()} LIMIT $${sizeUsd.toFixed(2)} on market ${marketIndex} @ $${(limitPrice / PRICE_PRECISION).toFixed(2)} (maker) | tx: ${txSig}`
    );
    return txSig;
  }

  const orderParams = {
    orderType: OrderType.MARKET,
    marketType: MarketType.PERP,
    marketIndex,
    direction: perpDirection,
    baseAssetAmount: new BN(Math.floor(baseAmount)),
    reduceOnly: false,
  };

  const txSig = await driftClient.placePerpOrder(orderParams);
  console.log(
    `Opened ${direction.toUpperCase()} MARKET $${sizeUsd.toFixed(2)} on market ${marketIndex} (taker) | tx: ${txSig}`
  );
  return txSig;
}

export async function closeBasisPosition(
  driftClient: DriftClient,
  marketIndex: number
): Promise<string> {
  const user = driftClient.getUser();
  const position = user.getPerpPosition(marketIndex);
  if (!position || position.baseAssetAmount.isZero()) {
    console.log(`No position to close on market ${marketIndex}`);
    return "";
  }

  if (STRATEGY_CONFIG.useLimitOrders) {
    const oraclePrice = driftClient.getOracleDataForPerpMarket(marketIndex);
    const price = oraclePrice.price.toNumber() / PRICE_PRECISION;
    // For closing short (buying back), place limit slightly below oracle
    const spreadMultiplier = 1 - STRATEGY_CONFIG.limitOrderSpreadBps / 10000;
    const limitPrice = Math.floor(price * spreadMultiplier * PRICE_PRECISION);

    const orderParams = {
      orderType: OrderType.LIMIT,
      marketType: MarketType.PERP,
      marketIndex,
      direction: PositionDirection.LONG,
      baseAssetAmount: position.baseAssetAmount.abs(),
      price: new BN(limitPrice),
      reduceOnly: true,
      postOnly: PostOnlyParams.MUST_POST_ONLY,
    };

    const txSig = await driftClient.placePerpOrder(orderParams);
    console.log(
      `Close LIMIT on market ${marketIndex} @ $${(limitPrice / PRICE_PRECISION).toFixed(2)} (maker) | tx: ${txSig}`
    );
    return txSig;
  }

  const orderParams = {
    orderType: OrderType.MARKET,
    marketType: MarketType.PERP,
    marketIndex,
    direction: PositionDirection.LONG,
    baseAssetAmount: position.baseAssetAmount.abs(),
    reduceOnly: true,
  };

  const txSig = await driftClient.placePerpOrder(orderParams);
  console.log(`Closed MARKET on market ${marketIndex} (taker) | tx: ${txSig}`);
  return txSig;
}

export function shouldExitPosition(
  position: BasisPosition,
  currentFundingRate: number
): { exit: boolean; reason: string } {
  const { exitFundingBps, maxDrawdownPct } = STRATEGY_CONFIG;
  const exitThreshold = exitFundingBps / 10000;

  // Exit if funding turned negative
  if (currentFundingRate < exitThreshold) {
    return {
      exit: true,
      reason: `Funding rate ${(currentFundingRate * 100).toFixed(4)}% below exit threshold`,
    };
  }

  return { exit: false, reason: "" };
}
