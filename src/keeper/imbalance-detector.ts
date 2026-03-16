import { DRIFT_DATA_API } from "../config/constants";
import { STRATEGY_CONFIG } from "../config/vault";

const { signalWeights, signalScaleFactors } = STRATEGY_CONFIG;

export interface MarketImbalance {
  market: string;
  marketIndex: number;
  // Price signals
  oraclePrice: number;
  markPrice: number;
  premiumPct: number; // (mark - oracle) / oracle × 100
  // OI signals
  longOI: number;
  shortOI: number;
  oiImbalancePct: number; // (long - |short|) / (long + |short|) × 100
  totalOI: number;
  // Funding
  fundingRate24h: number;
  annualizedFundingPct: number;
  // Composite signal
  signal: ImbalanceSignal;
  signalStrength: number; // 0-100
}

export type ImbalanceSignal =
  | "strong_short" // High funding + mark > oracle + long-heavy OI → SHORT
  | "moderate_short"
  | "neutral"
  | "moderate_long"
  | "strong_long"; // Low/neg funding + mark < oracle + short-heavy OI → LONG

export type TradeDirection = "short" | "long" | "none";

/**
 * Drift AMM Imbalance Detector
 *
 * Capitalizes on three Drift-native inefficiencies:
 * 1. OI Imbalance — when longs dominate, funding rises → short to collect
 * 2. Mark/Oracle Spread — when mark > oracle, premium will converge → short
 * 3. Funding Rate — direct measure of supply/demand imbalance
 *
 * These three signals are combined into a composite score that determines
 * entry direction and position sizing.
 *
 * Revenue sources:
 * - Funding payments (primary)
 * - Premium convergence (mark → oracle mean reversion)
 * - OI rebalancing (positioning ahead of funding changes)
 */
export async function fetchMarketImbalances(): Promise<MarketImbalance[]> {
  const res = await fetch(`${DRIFT_DATA_API}/stats/markets`);
  if (!res.ok) throw new Error(`Failed to fetch markets: ${res.status}`);

  const body = (await res.json()) as {
    success: boolean;
    markets: Array<{
      symbol: string;
      marketIndex: number;
      marketType: string;
      oraclePrice: string;
      markPrice: string;
      openInterest: { long: string; short: string };
      fundingRate24h: string;
    }>;
  };

  if (!body.success || !body.markets) {
    throw new Error("Unexpected market stats response");
  }

  return body.markets
    .filter((m) => m.marketType === "perp")
    .map((m) => {
      const oracle = parseFloat(m.oraclePrice);
      const mark = parseFloat(m.markPrice);
      const longOI = parseFloat(m.openInterest.long);
      const shortOI = Math.abs(parseFloat(m.openInterest.short));
      const totalOI = longOI + shortOI;
      const funding24h = parseFloat(m.fundingRate24h);

      // Premium: positive = mark above oracle (bullish pressure)
      const premiumPct = oracle > 0 ? ((mark - oracle) / oracle) * 100 : 0;

      // OI imbalance: positive = more longs than shorts
      const oiImbalancePct =
        totalOI > 0 ? ((longOI - shortOI) / totalOI) * 100 : 0;

      // Annualized funding
      const annualizedFundingPct = funding24h * 24 * 365 * 100;

      // Compute composite signal
      const { signal, signalStrength, direction } = computeSignal(
        premiumPct,
        oiImbalancePct,
        funding24h
      );

      return {
        market: m.symbol,
        marketIndex: m.marketIndex,
        oraclePrice: oracle,
        markPrice: mark,
        premiumPct,
        longOI,
        shortOI,
        oiImbalancePct,
        totalOI,
        fundingRate24h: funding24h,
        annualizedFundingPct,
        signal,
        signalStrength,
      };
    });
}

function computeSignal(
  premiumPct: number,
  oiImbalancePct: number,
  fundingRate: number
): { signal: ImbalanceSignal; signalStrength: number; direction: TradeDirection } {
  // Score each component (-1 to +1 scale, positive = short signal)
  // Scale factors and weights are configurable via STRATEGY_CONFIG
  const fundingScore = Math.max(-1, Math.min(1, fundingRate * signalScaleFactors.funding));
  const premiumScore = Math.max(-1, Math.min(1, premiumPct * signalScaleFactors.premium));
  const oiScore = Math.max(-1, Math.min(1, oiImbalancePct / signalScaleFactors.oi));

  // Weighted composite (configurable via STRATEGY_CONFIG.signalWeights)
  const composite =
    fundingScore * signalWeights.funding + premiumScore * signalWeights.premium + oiScore * signalWeights.oi;

  const signalStrength = Math.abs(composite) * 100;

  let signal: ImbalanceSignal;
  let direction: TradeDirection;

  if (composite > 0.6) {
    signal = "strong_short";
    direction = "short";
  } else if (composite > 0.2) {
    signal = "moderate_short";
    direction = "short";
  } else if (composite < -0.6) {
    signal = "strong_long";
    direction = "long";
  } else if (composite < -0.2) {
    signal = "moderate_long";
    direction = "long";
  } else {
    signal = "neutral";
    direction = "none";
  }

  return { signal, signalStrength, direction };
}

/**
 * Determine trade direction from imbalance signals.
 *
 * Entry logic:
 *   IF funding high AND mark > oracle → SHORT (premium convergence + funding)
 *   IF funding negative AND mark < oracle → LONG (discount convergence + funding)
 *   IF signals conflict → reduce size or skip
 */
export function getTradeDirection(
  imbalance: MarketImbalance
): { direction: TradeDirection; reason: string; confidence: number } {
  const { signal, signalStrength, premiumPct, oiImbalancePct, fundingRate24h } = imbalance;

  // Minimum signal strength to trade
  if (signalStrength < STRATEGY_CONFIG.minSignalStrength) {
    return {
      direction: "none",
      reason: `Signal too weak (${signalStrength.toFixed(0)}% < ${STRATEGY_CONFIG.minSignalStrength}%)`,
      confidence: signalStrength,
    };
  }

  if (signal === "strong_short" || signal === "moderate_short") {
    const reasons = [];
    if (fundingRate24h > 0) reasons.push(`funding +${(fundingRate24h * 100).toFixed(3)}%`);
    if (premiumPct > 0) reasons.push(`premium +${premiumPct.toFixed(3)}%`);
    if (oiImbalancePct > 0) reasons.push(`OI long-heavy ${oiImbalancePct.toFixed(1)}%`);
    return {
      direction: "short",
      reason: `SHORT: ${reasons.join(", ")}`,
      confidence: signalStrength,
    };
  }

  if (signal === "strong_long" || signal === "moderate_long") {
    const reasons = [];
    if (fundingRate24h < 0) reasons.push(`funding ${(fundingRate24h * 100).toFixed(3)}%`);
    if (premiumPct < 0) reasons.push(`discount ${premiumPct.toFixed(3)}%`);
    if (oiImbalancePct < 0) reasons.push(`OI short-heavy ${oiImbalancePct.toFixed(1)}%`);
    return {
      direction: "long",
      reason: `LONG: ${reasons.join(", ")}`,
      confidence: signalStrength,
    };
  }

  return {
    direction: "none",
    reason: `Neutral — conflicting signals`,
    confidence: signalStrength,
  };
}

/**
 * Rank markets by signal strength for capital allocation.
 */
export function rankByImbalance(
  imbalances: MarketImbalance[]
): MarketImbalance[] {
  return imbalances
    .filter((m) => {
      // Apply market whitelist/blacklist
      if (STRATEGY_CONFIG.excludeMarkets.includes(m.market)) return false;
      if (
        STRATEGY_CONFIG.allowedMarkets.length > 0 &&
        !STRATEGY_CONFIG.allowedMarkets.includes(m.market)
      )
        return false;
      // Minimum OI
      if (m.totalOI * m.oraclePrice < STRATEGY_CONFIG.minMarketOI) return false;
      // Must have a non-neutral signal
      return m.signal !== "neutral";
    })
    .sort((a, b) => b.signalStrength - a.signalStrength);
}
