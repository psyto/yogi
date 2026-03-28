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
  // CEX OI data
  binanceOI: number;       // Binance open interest (USD)
  bybitOI: number;         // Bybit open interest (USD)
  oiSignal: "oi_surge" | "oi_drop" | "stable" | "no_data";
}

// Track previous OI values for change detection
const previousOI: Map<string, { binance: number; bybit: number }> = new Map();

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
  openInterest: string;
}

interface BinanceOIResponse {
  symbol: string;
  openInterest: string;
  time: number;
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
 * Fetch Binance open interest for all USDT perps.
 * Returns map of symbol -> OI in USD.
 */
async function fetchBinanceOI(): Promise<Map<string, number>> {
  const map = new Map<string, number>();
  try {
    const symbols = Object.values(DRIFT_TO_CEX).map((v) => v.binance);
    for (const symbol of symbols) {
      const res = await fetch(
        `https://fapi.binance.com/fapi/v1/openInterest?symbol=${symbol}`
      );
      if (!res.ok) continue;
      const data = (await res.json()) as BinanceOIResponse;
      // OI is in base asset — multiply by price to get USD
      const priceRes = await fetch(
        `https://fapi.binance.com/fapi/v1/ticker/price?symbol=${symbol}`
      );
      if (priceRes.ok) {
        const priceData = (await priceRes.json()) as { price: string };
        const oiUsd = parseFloat(data.openInterest) * parseFloat(priceData.price);
        map.set(symbol, oiUsd);
      }
    }
  } catch {
    // Silently fail
  }
  return map;
}

/**
 * Fetch Bybit open interest.
 * Returns map of symbol -> OI in USD.
 */
async function fetchBybitOI(): Promise<Map<string, number>> {
  const map = new Map<string, number>();
  try {
    const symbols = Object.values(DRIFT_TO_CEX).map((v) => v.bybit);
    const unique = [...new Set(symbols)];

    for (const symbol of unique) {
      const res = await fetch(
        `https://api.bybit.com/v5/market/open-interest?category=linear&symbol=${symbol}&intervalTime=1h&limit=1`
      );
      if (!res.ok) continue;
      const data = (await res.json()) as {
        result?: { list?: Array<{ openInterest: string }> };
      };
      const oi = data.result?.list?.[0];
      if (oi) {
        // Bybit returns OI in base asset — get price to convert
        const tickerRes = await fetch(
          `https://api.bybit.com/v5/market/tickers?category=linear&symbol=${symbol}`
        );
        if (tickerRes.ok) {
          const tickerData = (await tickerRes.json()) as {
            result?: { list?: Array<{ lastPrice: string }> };
          };
          const price = parseFloat(tickerData.result?.list?.[0]?.lastPrice ?? "0");
          map.set(symbol, parseFloat(oi.openInterest) * price);
        }
      }
    }
  } catch {
    // Silently fail
  }
  return map;
}

/**
 * Classify OI change signal.
 */
function classifyOISignal(
  market: string,
  binanceOI: number,
  bybitOI: number
): "oi_surge" | "oi_drop" | "stable" | "no_data" {
  const prev = previousOI.get(market);
  const totalOI = binanceOI + bybitOI;

  // Store current for next comparison
  previousOI.set(market, { binance: binanceOI, bybit: bybitOI });

  if (!prev || totalOI === 0) return "no_data";

  const prevTotal = prev.binance + prev.bybit;
  if (prevTotal === 0) return "no_data";

  const changePct = ((totalOI - prevTotal) / prevTotal) * 100;

  // >10% increase in one cycle (5 min) = surge
  if (changePct > 10) return "oi_surge";
  // >10% decrease = drop
  if (changePct < -10) return "oi_drop";
  return "stable";
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
      // Drift 24h rate is cumulative daily, annualize: rate * 365 * 100
      const rate24h = parseFloat(m.fundingRates["24h"]);
      map.set(m.symbol, rate24h * 365 * 100);
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
  const [driftRates, binanceRates, bybitRates, binanceOIMap, bybitOIMap] = await Promise.all([
    fetchDriftFunding(),
    fetchBinanceFunding(),
    fetchBybitFunding(),
    fetchBinanceOI(),
    fetchBybitOI(),
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

    // CEX OI data
    const binanceOI = binanceOIMap.get(cexMapping.binance) ?? 0;
    const bybitOI = bybitOIMap.get(cexMapping.bybit) ?? 0;
    const oiSignal = classifyOISignal(market, binanceOI, bybitOI);

    results.push({
      market,
      driftRate,
      binanceRate: binanceAnnualized,
      bybitRate: bybitAnnualized,
      spread,
      convergenceSignal,
      confidence,
      binanceOI,
      bybitOI,
      oiSignal,
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
 * Get OI-based risk adjustment.
 * CEX OI surge = traders piling in = higher funding ahead (good for shorts).
 * CEX OI drop = traders exiting = funding may flip (caution).
 */
export function getOIAdjustment(venue: VenueFunding): {
  adjustment: number;
  reason: string;
} {
  if (venue.oiSignal === "oi_surge") {
    return {
      adjustment: 0.1,
      reason: `CEX OI surging ($${((venue.binanceOI + venue.bybitOI) / 1e6).toFixed(1)}M) → more funding ahead`,
    };
  }
  if (venue.oiSignal === "oi_drop") {
    return {
      adjustment: -0.2,
      reason: `CEX OI dropping ($${((venue.binanceOI + venue.bybitOI) / 1e6).toFixed(1)}M) → funding may flip, caution`,
    };
  }
  return { adjustment: 0, reason: "" };
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
    const oiStr = v.binanceOI > 0 || v.bybitOI > 0
      ? ` | OI: $${((v.binanceOI + v.bybitOI) / 1e6).toFixed(1)}M ${v.oiSignal !== "stable" && v.oiSignal !== "no_data" ? `[${v.oiSignal}]` : ""}`
      : "";
    lines.push(
      `  ${v.market}: ${driftStr} | ${binStr} | ${bybStr} | ${spreadStr} → ${v.convergenceSignal} (${v.confidence.toFixed(0)}%)${oiStr}`
    );
  }
  return lines.join("\n");
}
