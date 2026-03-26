/**
 * Slippage Guard — checks AMM depth before opening DN positions on Drift.
 *
 * Ported from Kodiak's slippage_guard.py (Hyperliquid L2 order book walker)
 * to work with Drift's AMM-based perp markets and spot markets.
 *
 * Drift perps use a virtual AMM (constant product: x * y = k). We estimate
 * slippage by computing the price impact of a trade against the AMM reserves.
 *
 * For spot markets, Drift also uses an AMM with base/quote reserves. We apply
 * the same constant-product formula.
 */

import { DriftClient } from "@drift-labs/sdk";
import { BASE_PRECISION, PRICE_PRECISION } from "../config/constants";
import { DN_MARKET_MAP } from "./delta-neutral";

// --- Types ---

export interface SlippageEstimate {
  coin: string;
  side: string;              // "buy" or "sell"
  marketType: string;        // "spot" or "perp"
  sizeCoins: number;
  estimatedSlippagePct: number;
  sufficient: boolean;
  reason: string;
}

export interface DnSlippageCheck {
  ok: boolean;
  spot: SlippageEstimate;
  perp: SlippageEstimate;
  reason: string;
}

// --- AMM Slippage Estimation ---

/**
 * Estimate slippage for a perp trade using the AMM's constant-product reserves.
 *
 * Drift perp AMM: baseAssetReserve * quoteAssetReserve = k
 * A buy (long) removes base and adds quote; a sell (short) adds base and removes quote.
 *
 * Price impact = |avg_fill_price - current_price| / current_price
 */
function estimatePerpSlippage(
  driftClient: DriftClient,
  perpIndex: number,
  sizeCoins: number,
  side: "buy" | "sell",
  coin: string,
): SlippageEstimate {
  try {
    const perpMarket = driftClient.getPerpMarketAccount(perpIndex);
    if (!perpMarket) {
      return {
        coin, side, marketType: "perp", sizeCoins,
        estimatedSlippagePct: 100, sufficient: false,
        reason: `No perp market account for index ${perpIndex}`,
      };
    }

    const amm = perpMarket.amm;

    // Get oracle price as the "fair" reference price
    const oracleData = driftClient.getOracleDataForPerpMarket(perpIndex);
    const oraclePrice = oracleData.price.toNumber() / PRICE_PRECISION;

    if (oraclePrice <= 0 || !isFinite(oraclePrice)) {
      return {
        coin, side, marketType: "perp", sizeCoins,
        estimatedSlippagePct: 100, sufficient: false,
        reason: `Invalid oracle price: ${oraclePrice}`,
      };
    }

    // AMM reserves (in base precision units)
    const baseReserve = amm.baseAssetReserve.toNumber() / BASE_PRECISION;
    const quoteReserve = amm.quoteAssetReserve.toNumber() / BASE_PRECISION;

    if (baseReserve <= 0 || quoteReserve <= 0) {
      return {
        coin, side, marketType: "perp", sizeCoins,
        estimatedSlippagePct: 100, sufficient: false,
        reason: `Invalid AMM reserves: base=${baseReserve} quote=${quoteReserve}`,
      };
    }

    // Peg multiplier scales the AMM price to match the oracle
    const pegMultiplier = amm.pegMultiplier.toNumber() / PRICE_PRECISION;

    // Current AMM price = (quoteReserve / baseReserve) * pegMultiplier
    const ammPrice = (quoteReserve / baseReserve) * pegMultiplier;

    // Constant product: k = baseReserve * quoteReserve
    const k = baseReserve * quoteReserve;

    let newBaseReserve: number;
    let newQuoteReserve: number;

    if (side === "sell") {
      // Selling (shorting): add base, remove quote
      newBaseReserve = baseReserve + sizeCoins;
      newQuoteReserve = k / newBaseReserve;
    } else {
      // Buying (longing): remove base, add quote
      newBaseReserve = baseReserve - sizeCoins;
      if (newBaseReserve <= 0) {
        return {
          coin, side, marketType: "perp", sizeCoins,
          estimatedSlippagePct: 100, sufficient: false,
          reason: `Trade size (${sizeCoins.toFixed(4)}) exceeds AMM base reserve (${baseReserve.toFixed(4)})`,
        };
      }
      newQuoteReserve = k / newBaseReserve;
    }

    // Quote exchanged = |quoteReserve - newQuoteReserve|
    const quoteExchanged = Math.abs(quoteReserve - newQuoteReserve) * pegMultiplier;
    const avgFillPrice = quoteExchanged / sizeCoins;

    // Slippage vs oracle price (more reliable than AMM mid-price)
    const slippagePct = Math.abs(avgFillPrice - oraclePrice) / oraclePrice * 100;

    return {
      coin, side, marketType: "perp", sizeCoins,
      estimatedSlippagePct: slippagePct,
      sufficient: true,
      reason: `avg_fill=$${avgFillPrice.toFixed(4)} vs oracle=$${oraclePrice.toFixed(4)} (amm=$${ammPrice.toFixed(4)})`,
    };
  } catch (e) {
    return {
      coin, side, marketType: "perp", sizeCoins,
      estimatedSlippagePct: 100, sufficient: false,
      reason: `Error estimating perp slippage: ${e}`,
    };
  }
}

/**
 * Estimate slippage for a spot trade.
 *
 * Drift spot markets don't have a traditional AMM with base/quote reserves
 * like perps do. Instead, we use a simple heuristic: compare the trade size
 * against the spot market's deposit pool to gauge liquidity depth.
 *
 * For small trades relative to pool size, slippage is negligible.
 * We estimate slippage as: (tradeSize / poolDepth) * scaleFactor
 */
function estimateSpotSlippage(
  driftClient: DriftClient,
  spotIndex: number,
  sizeCoins: number,
  side: "buy" | "sell",
  coin: string,
): SlippageEstimate {
  try {
    const spotMarket = driftClient.getSpotMarketAccount(spotIndex);
    if (!spotMarket) {
      return {
        coin, side, marketType: "spot", sizeCoins,
        estimatedSlippagePct: 100, sufficient: false,
        reason: `No spot market account for index ${spotIndex}`,
      };
    }

    // Use deposit balance as a proxy for available liquidity
    const precision = Math.pow(10, spotMarket.decimals);
    const depositBalance = spotMarket.depositBalance.toNumber() / precision;

    if (depositBalance <= 0) {
      return {
        coin, side, marketType: "spot", sizeCoins,
        estimatedSlippagePct: 100, sufficient: false,
        reason: `No deposit balance for spot market ${coin}`,
      };
    }

    // Estimate: slippage scales with trade size relative to pool depth.
    // This is a conservative linear estimate. Real slippage from Serum/Phoenix
    // order books would be more accurate but requires extra infra.
    // Scale factor of 50 means: trade = 1% of pool => ~0.5% slippage
    const scaleFactor = 50;
    const utilizationPct = (sizeCoins / depositBalance) * 100;
    const estimatedSlippagePct = utilizationPct * (scaleFactor / 100);

    if (sizeCoins > depositBalance * 0.5) {
      return {
        coin, side, marketType: "spot", sizeCoins,
        estimatedSlippagePct: estimatedSlippagePct,
        sufficient: false,
        reason: `Trade size (${sizeCoins.toFixed(4)} ${coin}) is >${(50).toFixed(0)}% of pool (${depositBalance.toFixed(2)})`,
      };
    }

    return {
      coin, side, marketType: "spot", sizeCoins,
      estimatedSlippagePct,
      sufficient: true,
      reason: `${sizeCoins.toFixed(4)} ${coin} is ${utilizationPct.toFixed(3)}% of pool (${depositBalance.toFixed(2)})`,
    };
  } catch (e) {
    return {
      coin, side, marketType: "spot", sizeCoins,
      estimatedSlippagePct: 100, sufficient: false,
      reason: `Error estimating spot slippage: ${e}`,
    };
  }
}

// --- Public API ---

/**
 * Check if both legs of a DN position can be opened with acceptable slippage.
 *
 * @param driftClient - Initialized Drift client with subscribed markets
 * @param marketName  - Market name (e.g., "SOL-PERP")
 * @param spotSizeCoins  - Spot buy size in coins
 * @param perpSizeCoins  - Perp short size in coins
 * @param maxSlippagePct - Maximum acceptable slippage per leg (default 0.5%)
 * @returns {ok, spot, perp, reason}
 */
export function checkDnSlippage(
  driftClient: DriftClient,
  marketName: string,
  spotSizeCoins: number,
  perpSizeCoins: number,
  maxSlippagePct: number = 0.5,
): DnSlippageCheck {
  const mapping = DN_MARKET_MAP[marketName];
  if (!mapping) {
    const empty: SlippageEstimate = {
      coin: marketName, side: "unknown", marketType: "unknown",
      sizeCoins: 0, estimatedSlippagePct: 100, sufficient: false,
      reason: `No DN mapping for ${marketName}`,
    };
    return { ok: false, spot: empty, perp: empty, reason: `No DN mapping for ${marketName}` };
  }

  const { spotIndex, perpIndex } = mapping;
  const coin = marketName.replace("-PERP", "");

  // Estimate slippage for each leg
  const spotEst = estimateSpotSlippage(driftClient, spotIndex, spotSizeCoins, "buy", coin);
  const perpEst = estimatePerpSlippage(driftClient, perpIndex, perpSizeCoins, "sell", coin);

  const spotOk = spotEst.sufficient && spotEst.estimatedSlippagePct <= maxSlippagePct;
  const perpOk = perpEst.sufficient && perpEst.estimatedSlippagePct <= maxSlippagePct;

  if (spotOk && perpOk) {
    return {
      ok: true,
      spot: spotEst,
      perp: perpEst,
      reason: `Slippage OK: spot=${spotEst.estimatedSlippagePct.toFixed(3)}% perp=${perpEst.estimatedSlippagePct.toFixed(3)}%`,
    };
  }

  const reasons: string[] = [];
  if (!spotOk) {
    reasons.push(`Spot: ${spotEst.reason} (slippage=${spotEst.estimatedSlippagePct.toFixed(3)}%)`);
  }
  if (!perpOk) {
    reasons.push(`Perp: ${perpEst.reason} (slippage=${perpEst.estimatedSlippagePct.toFixed(3)}%)`);
  }

  return {
    ok: false,
    spot: spotEst,
    perp: perpEst,
    reason: reasons.join(" | "),
  };
}
