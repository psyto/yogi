/**
 * Cross-Venue Funding Detector — 5th signal dimension for Yogi.
 *
 * Compares Drift's funding rate against Binance and Bybit.
 * When Drift funding diverges significantly from CEX funding, it signals
 * either an arbitrage opportunity or an impending convergence.
 *
 * Use cases:
 * 1. Drift funding >> CEX funding → will likely converge down → SHORT is safer
 * 2. Drift funding << CEX funding → will likely converge up → LONG is safer
 * 3. All venues aligned → strong directional signal, higher confidence
 */

import { DRIFT_DATA_API } from "../config/constants";
import { STRATEGY_CONFIG } from "../config/vault";

export interface VenueFunding {
  market: string;
  driftRate: number;       // Drift 24h annualized %
  binanceRate: number;     // Binance annualized %
  bybitRate: number;       // Bybit annualized %
  spread: number;          // Drift - avg CEX (annualized %)
  convergenceSignal: "drift_high" | "drift_low" | "aligned" | "no_data";
  confidence: number;      // 0-100
}

// Map Drift market names to CEX symbols
const DRIFT_TO_CEX: Record<string, { binance: string; bybit: string }> = {
  "SOL-PERP": { binance: "SOLUSDT", bybit: "SOLUSDT" },
  "BTC-PERP": { binance: "BTCUSDT", bybit: "BTCUSDT" },
  "ETH-PERP": { binance: "ETHUSDT", bybit: "ETHUSDT" },
  "DOGE-PERP": { binance: "DOGEUSDT", bybit: "DOGEUSDT" },
  "SUI-PERP": { binance: "SUIUSDT", bybit: "SUIUSDT" },
  "AVAX-PERP": { binance: "AVAXUSDT", bybit: "AVAXUSDT" },
};

interface BinancePremiumIndex {
  symbol: string;
  lastFundingRate: string;
}

interface BybitTicker {
  symbol: string;
  fundingRate: string;
}

/**
 * Fetch Binance funding rates for all USDT perps.
 * Returns map of symbol -> 8h funding rate (as decimal).
 */
async function fetchBinanceFunding(): Promise<Map<string, number>> {
  const map = new Map<string, number>();
  try {
    const res = await fetch("https://fapi.binance.com/fapi/v1/premiumIndex");
    if (!res.ok) return map;

    const data = (await res.json()) as BinancePremiumIndex[];
    for (const item of data) {
      map.set(item.symbol, parseFloat(item.lastFundingRate));
    }
  } catch {
    // Silently fail — CEX data is optional
  }
  return map;
}

/**
 * Fetch Bybit funding rates for linear perps.
 * Returns map of symbol -> 8h funding rate (as decimal).
 */
async function fetchBybitFunding(): Promise<Map<string, number>> {
  const map = new Map<string, number>();
  try {
    const symbols = Object.values(DRIFT_TO_CEX).map((v) => v.bybit);
    const unique = [...new Set(symbols)];

    for (const symbol of unique) {
      const res = await fetch(
        `https://api.bybit.com/v5/market/tickers?category=linear&symbol=${symbol}`
      );
      if (!res.ok) continue;

      const data = (await res.json()) as {
        result?: { list?: BybitTicker[] };
      };
      const ticker = data.result?.list?.[0];
      if (ticker) {
        map.set(ticker.symbol, parseFloat(ticker.fundingRate));
      }
    }
  } catch {
    // Silently fail
  }
  return map;
}

/**
 * Fetch Drift funding rates.
 * Returns map of market name -> 24h annualized rate.
 */
async function fetchDriftFunding(): Promise<Map<string, number>> {
  const map = new Map<string, number>();
  try {
    const res = await fetch(`${DRIFT_DATA_API}/stats/fundingRates`);
    if (!res.ok) return map;

    const body = (await res.json()) as {
      success: boolean;
      markets: Array<{
        symbol: string;
        fundingRates: { "24h": string };
      }>;
    };

    if (!body.success || !body.markets) return map;

    for (const m of body.markets) {
      // Drift 24h rate is hourly, annualize: rate * 24 * 365 * 100
      const rate24h = parseFloat(m.fundingRates["24h"]);
      map.set(m.symbol, rate24h * 24 * 365 * 100);
    }
  } catch {
    // Silently fail
  }
  return map;
}

/**
 * Fetch and compare funding rates across Drift, Binance, and Bybit.
 */
export async function fetchCrossVenueFunding(): Promise<VenueFunding[]> {
  const [driftRates, binanceRates, bybitRates] = await Promise.all([
    fetchDriftFunding(),
    fetchBinanceFunding(),
    fetchBybitFunding(),
  ]);

  const results: VenueFunding[] = [];
  const allowedMarkets = STRATEGY_CONFIG.allowedMarkets;

  for (const market of allowedMarkets) {
    const cexMapping = DRIFT_TO_CEX[market];
    if (!cexMapping) continue;

    const driftRate = driftRates.get(market) ?? 0;

    // Binance/Bybit rates are 8h rates — annualize: rate * 3 * 365 * 100
    const binanceRaw = binanceRates.get(cexMapping.binance) ?? 0;
    const bybitRaw = bybitRates.get(cexMapping.bybit) ?? 0;
    const binanceAnnualized = binanceRaw * 3 * 365 * 100;
    const bybitAnnualized = bybitRaw * 3 * 365 * 100;

    const hasCex = binanceRaw !== 0 || bybitRaw !== 0;

    // CEX average (only available venues)
    const cexRates: number[] = [];
    if (binanceRaw !== 0) cexRates.push(binanceAnnualized);
    if (bybitRaw !== 0) cexRates.push(bybitAnnualized);
    const avgCex =
      cexRates.length > 0
        ? cexRates.reduce((s, r) => s + r, 0) / cexRates.length
        : 0;

    const spread = driftRate - avgCex;

    // Classify convergence signal
    const spreadThreshold =
      STRATEGY_CONFIG.crossVenueSpreadThresholdApy ?? 5.0;

    let convergenceSignal: VenueFunding["convergenceSignal"];
    let confidence: number;

    if (!hasCex) {
      convergenceSignal = "no_data";
      confidence = 0;
    } else if (spread > spreadThreshold) {
      convergenceSignal = "drift_high";
      confidence = Math.min(100, (Math.abs(spread) / spreadThreshold) * 50);
    } else if (spread < -spreadThreshold) {
      convergenceSignal = "drift_low";
      confidence = Math.min(100, (Math.abs(spread) / spreadThreshold) * 50);
    } else {
      convergenceSignal = "aligned";
      // Higher confidence when all agree on direction
      if (driftRate > 0 && avgCex > 0) {
        confidence = Math.min(100, (driftRate + avgCex) / 2);
      } else if (driftRate < 0 && avgCex < 0) {
        confidence = Math.min(100, Math.abs(driftRate + avgCex) / 2);
      } else {
        confidence = 20;
      }
    }

    results.push({
      market,
      driftRate,
      binanceRate: binanceAnnualized,
      bybitRate: bybitAnnualized,
      spread,
      convergenceSignal,
      confidence,
    });
  }

  return results;
}

/**
 * Get trade direction adjustment based on cross-venue funding comparison.
 */
export function getCrossVenueAdjustment(venue: VenueFunding): {
  adjustment: number;
  reason: string;
} {
  if (venue.convergenceSignal === "no_data") {
    return { adjustment: 0, reason: "No CEX data available" };
  }

  if (venue.convergenceSignal === "aligned") {
    if (venue.driftRate > 0) {
      return {
        adjustment: 0.2,
        reason: `All venues positive (spread ${venue.spread > 0 ? "+" : ""}${venue.spread.toFixed(1)}%) → strengthen SHORT`,
      };
    } else if (venue.driftRate < 0) {
      return {
        adjustment: -0.2,
        reason: `All venues negative (spread ${venue.spread.toFixed(1)}%) → strengthen LONG`,
      };
    }
    return { adjustment: 0, reason: "Venues aligned near zero" };
  }

  if (venue.convergenceSignal === "drift_high") {
    return {
      adjustment: 0.1,
      reason: `Drift funding ${venue.spread > 0 ? "+" : ""}${venue.spread.toFixed(1)}% above CEX → SHORT profitable but convergence risk`,
    };
  }

  if (venue.convergenceSignal === "drift_low") {
    return {
      adjustment: -0.15,
      reason: `Drift funding ${venue.spread.toFixed(1)}% below CEX → potential LONG as Drift converges up`,
    };
  }

  return { adjustment: 0, reason: "Unknown signal" };
}

/**
 * Format cross-venue funding comparison for logging.
 */
export function formatCrossVenue(venues: VenueFunding[]): string {
  if (venues.length === 0) return "Cross-venue: no data";

  const lines = ["Cross-venue funding comparison:"];
  for (const v of venues) {
    const driftStr = `Drift=${v.driftRate > 0 ? "+" : ""}${v.driftRate.toFixed(1)}%`;
    const binStr = v.binanceRate !== 0 ? `Bin=${v.binanceRate > 0 ? "+" : ""}${v.binanceRate.toFixed(1)}%` : "Bin=N/A";
    const bybStr = v.bybitRate !== 0 ? `Byb=${v.bybitRate > 0 ? "+" : ""}${v.bybitRate.toFixed(1)}%` : "Byb=N/A";
    const spreadStr = `spread=${v.spread > 0 ? "+" : ""}${v.spread.toFixed(1)}%`;
    lines.push(
      `  ${v.market}: ${driftStr} | ${binStr} | ${bybStr} | ${spreadStr} → ${v.convergenceSignal} (${v.confidence.toFixed(0)}%)`
    );
  }
  return lines.join("\n");
}
