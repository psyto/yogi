import { DRIFT_DATA_API } from "../config/constants";
import { STRATEGY_CONFIG } from "../config/vault";

export type VolRegime = "veryLow" | "low" | "normal" | "high" | "extreme";

export interface LeverageState {
  currentVol: number; // Annualized realized vol (decimal)
  currentVolBps: number;
  regime: VolRegime;
  targetLeverage: number;
  reason: string;
}

/**
 * Classify vol regime from realized volatility.
 */
export function classifyVolRegime(volBps: number): VolRegime {
  const t = STRATEGY_CONFIG.volRegimeThresholds;
  if (volBps < t.veryLow) return "veryLow";
  if (volBps < t.low) return "low";
  if (volBps < t.normal) return "normal";
  if (volBps < t.high) return "high";
  return "extreme";
}

/**
 * Compute target leverage based on current market volatility.
 *
 * Leverage scales INVERSELY with volatility:
 * - Low vol → higher leverage (safe, but less funding available)
 * - High vol → lower leverage (dangerous, but more funding available)
 * - Extreme vol → zero leverage (shut down)
 *
 * This addresses the critique that fixed 3-5x leverage is reckless
 * during volatility spikes.
 */
export function computeTargetLeverage(volBps: number): LeverageState {
  const regime = classifyVolRegime(volBps);
  const leverageMap = STRATEGY_CONFIG.leverageByVolRegime;
  const targetLeverage = Math.min(
    leverageMap[regime] ?? 0,
    STRATEGY_CONFIG.maxLeverage
  );

  return {
    currentVol: volBps / 10000,
    currentVolBps: volBps,
    regime,
    targetLeverage,
    reason:
      regime === "extreme"
        ? "Extreme vol — all positions closed"
        : `${regime} vol regime → ${targetLeverage}x leverage`,
  };
}

/**
 * Fetch recent realized volatility for a reference market (SOL-PERP).
 * Uses Parkinson estimator on hourly candles for efficiency.
 */
export async function fetchReferenceVol(): Promise<number> {
  const res = await fetch(
    `${DRIFT_DATA_API}/market/SOL-PERP/candles/60?limit=168`
  );
  if (!res.ok) {
    throw new Error(`Failed to fetch candles: ${res.status}`);
  }

  const body = (await res.json()) as {
    success: boolean;
    records: Array<{
      oracleHigh: number;
      oracleLow: number;
    }>;
  };

  if (!body.success || !body.records || body.records.length < 10) {
    throw new Error("Insufficient candle data for vol calculation");
  }

  // Parkinson estimator
  const ln2x4 = 4 * Math.LN2;
  let sumLogHL2 = 0;
  let validCount = 0;

  for (const c of body.records) {
    if (c.oracleHigh <= 0 || c.oracleLow <= 0 || c.oracleHigh < c.oracleLow)
      continue;
    const logHL = Math.log(c.oracleHigh / c.oracleLow);
    sumLogHL2 += logHL * logHL;
    validCount++;
  }

  if (validCount === 0) return 3000; // Default to 30% if no data

  const variance = sumLogHL2 / (ln2x4 * validCount);
  const hoursPerYear = 365.25 * 24;
  const annualizedVol = Math.sqrt(variance * hoursPerYear);

  const result = Math.round(annualizedVol * 10000); // Return in bps
  if (!isFinite(result) || isNaN(result)) return 3000; // Fallback on NaN/Infinity
  return result;
}
