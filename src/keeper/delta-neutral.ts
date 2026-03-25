/**
 * Delta-Neutral Position Manager — Yogi's upgraded execution layer.
 *
 * Instead of directional perp shorts, this module manages paired positions:
 *   - Buy spot asset on Drift (SOL, BTC, ETH)
 *   - Short same asset on Drift perps
 *
 * Price movement cancels out. Profit comes purely from funding rate collection.
 * Optional "tilt": perp short is X% larger than spot → slight short bias for
 * extra yield in bear markets. Tilt adjusts dynamically based on signals/vol.
 *
 * Drift spot market indexes: 1=SOL, 2=BTC, 3=ETH
 * Drift perp market indexes: 0=SOL-PERP, 1=BTC-PERP, 2=ETH-PERP
 */

import {
  DriftClient,
  PositionDirection,
  OrderType,
  MarketType,
  BN,
} from "@drift-labs/sdk";
import {
  BASE_PRECISION,
  PRICE_PRECISION,
} from "../config/constants";
import { STRATEGY_CONFIG } from "../config/vault";

// --- Types ---

export interface DeltaNeutralPosition {
  coin: string;             // e.g., "SOL", "BTC", "ETH"
  spotMarketIndex: number;  // Drift spot market index
  perpMarketIndex: number;  // Drift perp market index
  spotSizeCoins: number;    // Coins held in spot
  perpSizeCoins: number;    // Coins shorted in perp (positive number)
  spotEntryPrice: number;
  perpEntryPrice: number;
  entryFundingRate: number;
  entryTimestamp: number;
  cumulativeFunding: number;
  tiltPct: number;          // Short bias: 0.0 = pure DN, 0.1 = 10% extra short
}

// Spot/perp index mapping for DN-eligible markets on Drift
export const DN_MARKET_MAP: Record<string, { spotIndex: number; perpIndex: number }> = {
  "SOL-PERP": { spotIndex: 1, perpIndex: 0 },
  "BTC-PERP": { spotIndex: 2, perpIndex: 1 },
  "ETH-PERP": { spotIndex: 3, perpIndex: 2 },
};

// Capital allocation for DN positions
const SPOT_RATIO = 0.70;    // 70% to spot buy
const MARGIN_RATIO = 0.30;  // 30% for perp margin

// --- Helpers ---

export function getDelta(pos: DeltaNeutralPosition): number {
  return pos.spotSizeCoins - pos.perpSizeCoins;
}

export function getDeltaPct(pos: DeltaNeutralPosition): number {
  if (pos.spotSizeCoins <= 0) return 0;
  return (getDelta(pos) / pos.spotSizeCoins) * 100;
}

export function getNotionalUsd(pos: DeltaNeutralPosition): number {
  const avgPrice = (pos.spotEntryPrice + pos.perpEntryPrice) / 2;
  return pos.spotSizeCoins * avgPrice;
}

/**
 * Compute dynamic tilt based on regime, signals, and market conditions.
 *
 * - HIGH/CRITICAL signals → 0% (pure DN, protect capital)
 * - LOW signal → 30% of max tilt
 * - High vol → 50% of max tilt
 * - Normal vol → 70% of max tilt
 * - Low/veryLow vol → 100% of max tilt (full short bias)
 * - Negative funding → reduce tilt (shorts pay, not collect)
 */
export function computeDynamicTilt(
  signalSeverity: number,
  volRegime: string,
  currentFundingRate: number,
  maxTilt: number = STRATEGY_CONFIG.dnTiltPct ?? 0.10,
): number {
  // HIGH or CRITICAL — pure DN
  if (signalSeverity >= 2) return 0;

  let tilt: number;

  if (signalSeverity >= 1) {
    // LOW signal
    tilt = maxTilt * 0.3;
  } else if (volRegime === "high" || volRegime === "extreme") {
    tilt = maxTilt * 0.5;
  } else if (volRegime === "normal") {
    tilt = maxTilt * 0.7;
  } else {
    // veryLow or low — calm market
    tilt = maxTilt;
  }

  // If funding is negative, reduce tilt (shorts pay, not collect)
  if (currentFundingRate < 0) {
    tilt = Math.min(tilt, maxTilt * 0.2);
  }

  return Math.round(tilt * 1000) / 1000;
}

// --- Core DN Operations ---

/**
 * Open a delta-neutral position: buy spot + short perp on Drift.
 */
export async function openDeltaNeutral(
  driftClient: DriftClient,
  marketName: string,
  capitalUsd: number,
  tiltPct: number = 0,
): Promise<DeltaNeutralPosition | null> {
  const mapping = DN_MARKET_MAP[marketName];
  if (!mapping) {
    console.log(`No DN mapping for ${marketName} — not a DN-eligible market`);
    return null;
  }

  const { spotIndex, perpIndex } = mapping;
  const coin = marketName.replace("-PERP", "");

  // Get oracle price for the perp market
  const oracleData = driftClient.getOracleDataForPerpMarket(perpIndex);
  const price = oracleData.price.toNumber() / PRICE_PRECISION;
  if (price <= 0 || !isFinite(price)) {
    console.log(`Invalid oracle price for ${marketName}: ${price}`);
    return null;
  }

  // Calculate sizes
  const spotCapital = capitalUsd * SPOT_RATIO;
  const spotSizeCoins = spotCapital / price;

  // Round to market's step size
  const perpMarket = driftClient.getPerpMarketAccount(perpIndex);
  const stepSize = perpMarket
    ? perpMarket.amm.orderStepSize.toNumber() / BASE_PRECISION
    : 0.001;

  const roundToStep = (size: number) => Math.floor(size / stepSize) * stepSize;
  const roundedSpotSize = roundToStep(spotSizeCoins);

  if (roundedSpotSize <= 0) {
    console.log(`Spot size too small for ${marketName} (${spotSizeCoins} coins, step=${stepSize})`);
    return null;
  }

  // Apply tilt: perp short is larger than spot by tiltPct
  const perpSizeCoins = roundToStep(roundedSpotSize * (1 + tiltPct));

  const spotNotional = roundedSpotSize * price;
  const perpNotional = perpSizeCoins * price;
  const tiltLabel = tiltPct > 0 ? ` | tilt=${(tiltPct * 100).toFixed(0)}% short bias` : "";

  console.log(`\n--- Opening Delta-Neutral: ${coin}${tiltLabel} ---`);
  console.log(
    `Capital: $${capitalUsd.toFixed(2)} (spot: $${spotCapital.toFixed(2)}, margin: $${(capitalUsd - spotCapital).toFixed(2)})`
  );
  console.log(
    `Spot: ${roundedSpotSize.toFixed(6)} ${coin} ($${spotNotional.toFixed(2)}) | ` +
    `Perp: ${perpSizeCoins.toFixed(6)} ${coin} ($${perpNotional.toFixed(2)}) @ $${price.toFixed(2)}`
  );

  // Step 1: Buy spot on Drift
  try {
    const spotBaseAmount = new BN(Math.floor(roundedSpotSize * BASE_PRECISION));

    const spotTx = await driftClient.placeSpotOrder({
      orderType: OrderType.MARKET,
      marketType: MarketType.SPOT,
      marketIndex: spotIndex,
      direction: PositionDirection.LONG,
      baseAssetAmount: spotBaseAmount,
    });
    console.log(`Spot BUY: ${roundedSpotSize.toFixed(6)} ${coin} (market) | tx: ${spotTx}`);
  } catch (e) {
    console.error(`Spot buy failed for ${coin}:`, e);
    return null;
  }

  // Small delay to let spot settle on-chain
  await new Promise((r) => setTimeout(r, 2000));

  // Step 2: Short perp
  try {
    const perpBaseAmount = new BN(Math.floor(perpSizeCoins * BASE_PRECISION));

    const perpTx = await driftClient.placePerpOrder({
      orderType: OrderType.MARKET,
      marketType: MarketType.PERP,
      marketIndex: perpIndex,
      direction: PositionDirection.SHORT,
      baseAssetAmount: perpBaseAmount,
      reduceOnly: false,
    });
    console.log(`Perp SHORT: ${perpSizeCoins.toFixed(6)} ${coin} (market) | tx: ${perpTx}`);
  } catch (e) {
    console.error(`Perp short failed for ${coin}:`, e);
    // Try to unwind spot
    console.log("Unwinding spot position...");
    try {
      const spotBaseAmount = new BN(Math.floor(roundedSpotSize * BASE_PRECISION));
      await driftClient.placeSpotOrder({
        orderType: OrderType.MARKET,
        marketType: MarketType.SPOT,
        marketIndex: spotIndex,
        direction: PositionDirection.SHORT,
        baseAssetAmount: spotBaseAmount,
      });
      console.log("Spot unwound successfully");
    } catch (unwindErr) {
      console.error("Failed to unwind spot:", unwindErr);
    }
    return null;
  }

  const position: DeltaNeutralPosition = {
    coin,
    spotMarketIndex: spotIndex,
    perpMarketIndex: perpIndex,
    spotSizeCoins: roundedSpotSize,
    perpSizeCoins,
    spotEntryPrice: price,
    perpEntryPrice: price,
    entryFundingRate: 0,
    entryTimestamp: Date.now(),
    cumulativeFunding: 0,
    tiltPct,
  };

  const delta = getDelta(position);
  const deltaPctVal = getDeltaPct(position);
  const notional = getNotionalUsd(position);
  console.log(
    `DN opened: ${coin} | delta=${delta.toFixed(6)} (${deltaPctVal.toFixed(1)}%) | ` +
    `notional=$${notional.toFixed(2)}${tiltLabel}`
  );

  return position;
}

/**
 * Close a delta-neutral position: close perp short + sell spot.
 */
export async function closeDeltaNeutral(
  driftClient: DriftClient,
  position: DeltaNeutralPosition,
): Promise<boolean> {
  const { coin, spotMarketIndex, perpMarketIndex } = position;
  console.log(`\n--- Closing Delta-Neutral: ${coin} ---`);

  let success = true;

  // Step 1: Close perp short (buy to cover)
  try {
    const user = driftClient.getUser();
    const perpPos = user.getPerpPosition(perpMarketIndex);
    if (perpPos && !perpPos.baseAssetAmount.isZero()) {
      const perpTx = await driftClient.placePerpOrder({
        orderType: OrderType.MARKET,
        marketType: MarketType.PERP,
        marketIndex: perpMarketIndex,
        direction: PositionDirection.LONG,
        baseAssetAmount: perpPos.baseAssetAmount.abs(),
        reduceOnly: true,
      });
      console.log(`Perp CLOSE: ${coin} | tx: ${perpTx}`);
    } else {
      console.log(`No perp position to close on ${coin}`);
    }
  } catch (e) {
    console.error(`Perp close failed for ${coin}:`, e);
    success = false;
  }

  // Step 2: Sell spot — always use recorded size (getSpotPosition scaledBalance
  // uses different precision and is unreliable for detecting spot holdings)
  try {
    const spotBaseAmount = new BN(
      Math.floor(position.spotSizeCoins * BASE_PRECISION)
    );
    console.log(`Selling spot: ${position.spotSizeCoins.toFixed(6)} ${coin} (market index ${spotMarketIndex})`);
    const spotTx = await driftClient.placeSpotOrder({
      orderType: OrderType.MARKET,
      marketType: MarketType.SPOT,
      marketIndex: spotMarketIndex,
      direction: PositionDirection.SHORT,
      baseAssetAmount: spotBaseAmount,
    });
    console.log(`Spot SELL: ${position.spotSizeCoins.toFixed(6)} ${coin} | tx: ${spotTx}`);
  } catch (e) {
    console.error(`Spot sell failed for ${coin}:`, e);
    success = false;
  }

  return success;
}

/**
 * Check if delta has drifted beyond acceptable range.
 * DN positions can drift if spot/perp sizes diverge due to partial fills or funding.
 */
export function checkDeltaDrift(
  position: DeltaNeutralPosition,
  driftClient: DriftClient,
): { drifted: boolean; deltaPct: number; action: string } {
  const user = driftClient.getUser();

  // Get actual perp size
  const perpPos = user.getPerpPosition(position.perpMarketIndex);
  const actualPerpSize = perpPos
    ? Math.abs(perpPos.baseAssetAmount.toNumber() / BASE_PRECISION)
    : 0;

  // Use recorded spot size — Drift's getSpotPosition scaledBalance uses
  // different precision and is unreliable for reading actual token amounts.
  // Delta drift is primarily caused by perp size changes (liquidations, funding).
  const actualSpotSize = position.spotSizeCoins;

  const delta = actualSpotSize - actualPerpSize;
  const avgSize = (actualSpotSize + actualPerpSize) / 2;
  const deltaPct = avgSize > 0 ? Math.abs(delta / avgSize) * 100 : 0;

  // >5% drift needs rebalancing
  if (deltaPct > 5) {
    return {
      drifted: true,
      deltaPct,
      action: "rebalance",
    };
  }

  return { drifted: false, deltaPct, action: "none" };
}

/**
 * Format a DN position for logging.
 */
export function formatDnPosition(
  pos: DeltaNeutralPosition,
  currentPrice: number = 0,
): string {
  const spotPnl = currentPrice ? (currentPrice - pos.spotEntryPrice) * pos.spotSizeCoins : 0;
  const perpPnl = currentPrice ? (pos.perpEntryPrice - currentPrice) * pos.perpSizeCoins : 0;
  const netPnl = spotPnl + perpPnl;

  const delta = getDelta(pos);
  const deltaPctVal = getDeltaPct(pos);
  const notional = getNotionalUsd(pos);
  const tiltInfo = pos.tiltPct > 0 ? ` tilt=${(pos.tiltPct * 100).toFixed(0)}%` : "";

  return (
    `${pos.coin} DN: spot=${pos.spotSizeCoins.toFixed(6)} perp=${pos.perpSizeCoins.toFixed(6)} ` +
    `delta=${delta.toFixed(6)} (${deltaPctVal.toFixed(1)}%)${tiltInfo} ` +
    `notional=$${notional.toFixed(2)}` +
    (currentPrice ? ` netPnL=$${netPnl.toFixed(4)}` : "")
  );
}

/**
 * Load existing on-chain positions and reconstruct DN state.
 * Called on startup to prevent duplicate position opening.
 */
export async function loadExistingDnPositions(
  driftClient: DriftClient,
): Promise<DeltaNeutralPosition[]> {
  const positions: DeltaNeutralPosition[] = [];
  const user = driftClient.getUser();

  for (const [marketName, mapping] of Object.entries(DN_MARKET_MAP)) {
    const { spotIndex, perpIndex } = mapping;
    const coin = marketName.replace("-PERP", "");

    // Check if we have both spot and perp positions
    const perpPos = user.getPerpPosition(perpIndex);

    const perpSize = perpPos
      ? Math.abs(perpPos.baseAssetAmount.toNumber() / BASE_PRECISION)
      : 0;

    // Use getTokenAmount for correct spot balance (handles precision internally)
    let spotSize = 0;
    try {
      const spotMarket = driftClient.getSpotMarketAccount(spotIndex);
      if (spotMarket) {
        const tokenAmount = user.getTokenAmount(spotIndex);
        const precision = Math.pow(10, spotMarket.decimals);
        spotSize = tokenAmount.toNumber() / precision;
      }
    } catch { /* no spot position */ }

    // Only count as DN if we have BOTH legs
    if (perpSize > 0.0001 && spotSize > 0.0001) {
      const oracleData = driftClient.getOracleDataForPerpMarket(perpIndex);
      const price = oracleData.price.toNumber() / PRICE_PRECISION;
      const tiltPct = spotSize > 0 ? Math.max(0, (perpSize - spotSize) / spotSize) : 0;

      const pos: DeltaNeutralPosition = {
        coin,
        spotMarketIndex: spotIndex,
        perpMarketIndex: perpIndex,
        spotSizeCoins: spotSize,
        perpSizeCoins: perpSize,
        spotEntryPrice: price,
        perpEntryPrice: price,
        entryFundingRate: 0,
        entryTimestamp: Date.now(),
        cumulativeFunding: 0,
        tiltPct,
      };

      positions.push(pos);
      console.log(
        `  Restored DN: ${coin} spot=${spotSize.toFixed(6)} perp=${perpSize.toFixed(6)} ` +
        `delta=${getDelta(pos).toFixed(6)} (${getDeltaPct(pos).toFixed(1)}%) ` +
        `tilt=${(tiltPct * 100).toFixed(0)}%`
      );
    } else if (spotSize > 0.0001 && perpSize <= 0.0001) {
      // Orphaned spot — perp leg was closed but spot wasn't sold
      console.log(
        `  WARNING: Orphaned spot ${coin} = ${spotSize.toFixed(6)} coins (no matching perp). Will sell.`
      );
      try {
        const spotBaseAmount = new BN(Math.floor(spotSize * BASE_PRECISION));
        await driftClient.placeSpotOrder({
          orderType: OrderType.MARKET,
          marketType: MarketType.SPOT,
          marketIndex: spotIndex,
          direction: PositionDirection.SHORT,
          baseAssetAmount: spotBaseAmount,
        });
        console.log(`  Sold orphaned spot: ${spotSize.toFixed(6)} ${coin}`);
      } catch (err) {
        console.error(`  Failed to sell orphaned spot ${coin}:`, err);
      }
    }
  }

  return positions;
}
