import { DRIFT_DATA_API } from "../config/constants";
import { STRATEGY_CONFIG } from "../config/vault";

/**
 * Drift Signal Detector — Yogi's intelligence layer.
 *
 * Extends Vigil's multi-dimensional anomaly detection pattern to Drift-specific
 * metrics. Instead of monitoring NCN uptime/TVL/restaker drain, we monitor:
 *
 * 1. OI Imbalance Shift — rapid change in long/short ratio across markets
 * 2. Liquidation Cascade — spike in liquidation volume signaling forced selling
 * 3. Funding Rate Volatility — unstable funding = regime transition
 * 4. Spread Blow-out — mark/oracle divergence indicating stress
 *
 * Each dimension produces a severity level (0-3). The max severity across
 * all dimensions becomes the aggregate signal that drives Yogi's regime engine.
 *
 * All thresholds are configurable via STRATEGY_CONFIG.signalThresholds.
 */

// Signal severity levels (matches Vigil's pattern)
export const SIGNAL_NONE = 0;
export const SIGNAL_LOW = 1;
export const SIGNAL_HIGH = 2;
export const SIGNAL_CRITICAL = 3;

export type SignalSeverity = 0 | 1 | 2 | 3;

export interface SignalEvent {
  dimension: "oi_shift" | "liquidation_cascade" | "funding_volatility" | "spread_blowout";
  severity: SignalSeverity;
  reason: string;
  timestamp: number;
  metrics: Record<string, number>;
}

export interface DriftSignalState {
  severity: SignalSeverity;
  events: SignalEvent[];
  timestamp: number;
  marketSnapshots: MarketSnapshot[];
}

interface MarketSnapshot {
  market: string;
  marketIndex: number;
  longOI: number;
  shortOI: number;
  oiImbalancePct: number;
  markPrice: number;
  oraclePrice: number;
  spreadPct: number;
  fundingRate24h: number;
}

interface FundingHistoryEntry {
  ts: number;
  fundingRate: string | number;
  oraclePriceTwap: string | number;
}

interface FundingHistoryResponse {
  success: boolean;
  records: FundingHistoryEntry[];
}

// Rolling history for change detection
const snapshotHistory: MarketSnapshot[][] = [];

// Funding rate history for volatility calculation
const fundingHistory: Map<string, number[]> = new Map();

/**
 * Classify severity from a value against low/high/critical thresholds.
 */
function classifySeverity(
  value: number,
  thresholds: { low: number; high: number; critical: number }
): SignalSeverity {
  if (value >= thresholds.critical) return SIGNAL_CRITICAL;
  if (value >= thresholds.high) return SIGNAL_HIGH;
  if (value >= thresholds.low) return SIGNAL_LOW;
  return SIGNAL_NONE;
}

/**
 * Fetch current market state from Drift Data API.
 */
async function fetchMarketSnapshots(): Promise<MarketSnapshot[]> {
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

      return {
        market: m.symbol,
        marketIndex: m.marketIndex,
        longOI,
        shortOI,
        oiImbalancePct: totalOI > 0 ? ((longOI - shortOI) / totalOI) * 100 : 0,
        markPrice: mark,
        oraclePrice: oracle,
        spreadPct: oracle > 0 ? ((mark - oracle) / oracle) * 100 : 0,
        fundingRate24h: parseFloat(m.fundingRate24h),
      };
    });
}

/**
 * Fetch funding rate history for a market to compute volatility.
 */
async function fetchFundingHistory(
  market: string,
  limit: number
): Promise<FundingHistoryEntry[]> {
  const res = await fetch(
    `${DRIFT_DATA_API}/market/${market}/fundingRates?limit=${limit}`
  );
  if (!res.ok) return [];
  const data = (await res.json()) as FundingHistoryResponse;
  return data.records ?? [];
}

/**
 * Detect OI imbalance shift — how fast the long/short ratio is changing.
 */
function detectOIShift(
  current: MarketSnapshot[],
  history: MarketSnapshot[][]
): SignalEvent | null {
  if (history.length < 2) return null;

  const oldest = history[0];
  let maxShift = 0;
  let worstMarket = "";

  for (const curr of current) {
    const prev = oldest.find((s) => s.marketIndex === curr.marketIndex);
    if (!prev) continue;

    const shift = Math.abs(curr.oiImbalancePct - prev.oiImbalancePct);
    if (shift > maxShift) {
      maxShift = shift;
      worstMarket = curr.market;
    }
  }

  const severity = classifySeverity(maxShift, STRATEGY_CONFIG.signalThresholds.oiShift);
  if (severity === SIGNAL_NONE) return null;

  return {
    dimension: "oi_shift",
    severity,
    reason: `OI imbalance shifted ${maxShift.toFixed(1)}% on ${worstMarket} in ~${history.length * 5}min`,
    timestamp: Date.now(),
    metrics: { maxShift, market: current.find((s) => s.market === worstMarket)?.marketIndex ?? 0 },
  };
}

/**
 * Detect liquidation cascade — proxied by sudden OI drop.
 * When OI drops rapidly without corresponding price move, it's forced liquidations.
 */
function detectLiquidationCascade(
  current: MarketSnapshot[],
  history: MarketSnapshot[][]
): SignalEvent | null {
  if (history.length < 2) return null;

  const oldest = history[0];
  let maxDrop = 0;
  let worstMarket = "";

  for (const curr of current) {
    const prev = oldest.find((s) => s.marketIndex === curr.marketIndex);
    if (!prev) continue;

    const prevTotalOI = prev.longOI + prev.shortOI;
    const currTotalOI = curr.longOI + curr.shortOI;
    if (prevTotalOI <= 0) continue;

    const dropPct = ((prevTotalOI - currTotalOI) / prevTotalOI) * 100;
    if (dropPct > maxDrop) {
      maxDrop = dropPct;
      worstMarket = curr.market;
    }
  }

  const severity = classifySeverity(maxDrop, STRATEGY_CONFIG.signalThresholds.oiDrop);
  if (severity === SIGNAL_NONE) return null;

  return {
    dimension: "liquidation_cascade",
    severity,
    reason: `OI dropped ${maxDrop.toFixed(1)}% on ${worstMarket} — likely liquidation cascade`,
    timestamp: Date.now(),
    metrics: { maxDrop, market: current.find((s) => s.market === worstMarket)?.marketIndex ?? 0 },
  };
}

/**
 * Detect funding rate volatility across major markets.
 * High funding vol = regime is transitioning, strategies need to adapt.
 */
async function detectFundingVolatility(
  markets: string[]
): Promise<SignalEvent | null> {
  let maxFundingVol = 0;
  let worstMarket = "";
  const maxHistory = STRATEGY_CONFIG.fundingHistorySize;
  const volWindow = STRATEGY_CONFIG.fundingVolWindow;

  for (const market of markets) {
    let history = fundingHistory.get(market);
    if (!history || history.length === 0) {
      const fetched = await fetchFundingHistory(market, maxHistory);
      // Normalize funding rate by oracle price to get a proportional rate.
      // Drift API returns fundingRate in absolute price terms (e.g. 1.044 for BTC),
      // not as a proportion. Dividing by oraclePriceTwap gives the actual rate.
      history = fetched.map((e) => {
        const rate = Number(e.fundingRate);
        const oracle = Number(e.oraclePriceTwap);
        return oracle > 0 ? rate / oracle : 0;
      });
      fundingHistory.set(market, history);
    }

    if (history.length < 10) continue;

    const recent = history.slice(-volWindow);
    const mean = recent.reduce((s, r) => s + r, 0) / recent.length;
    const variance = recent.reduce((s, r) => s + (r - mean) ** 2, 0) / recent.length;
    const stdDev = Math.sqrt(variance);

    // Annualize: stdDev per 1h period x sqrt(24 x 365) and convert to bps
    const annualizedVolBps = stdDev * Math.sqrt(24 * 365) * 10000;

    if (annualizedVolBps > maxFundingVol) {
      maxFundingVol = annualizedVolBps;
      worstMarket = market;
    }
  }

  const severity = classifySeverity(maxFundingVol, STRATEGY_CONFIG.signalThresholds.fundingVol);
  if (severity === SIGNAL_NONE) return null;

  return {
    dimension: "funding_volatility",
    severity,
    reason: `Funding rate vol ${maxFundingVol.toFixed(0)} bps (annualized) on ${worstMarket}`,
    timestamp: Date.now(),
    metrics: { maxFundingVol, worstMarket: 0 },
  };
}

/**
 * Detect spread blow-out — mark/oracle divergence across markets.
 * Large spreads indicate stress, low liquidity, or impending cascade.
 */
function detectSpreadBlowout(current: MarketSnapshot[]): SignalEvent | null {
  let maxSpread = 0;
  let worstMarket = "";

  for (const snap of current) {
    const absSpread = Math.abs(snap.spreadPct);
    if (absSpread > maxSpread) {
      maxSpread = absSpread;
      worstMarket = snap.market;
    }
  }

  const severity = classifySeverity(maxSpread, STRATEGY_CONFIG.signalThresholds.spread);
  if (severity === SIGNAL_NONE) return null;

  return {
    dimension: "spread_blowout",
    severity,
    reason: `Mark/oracle spread ${maxSpread.toFixed(2)}% on ${worstMarket}`,
    timestamp: Date.now(),
    metrics: { maxSpread, market: current.find((s) => s.market === worstMarket)?.marketIndex ?? 0 },
  };
}

/**
 * Run all signal detections and return aggregate state.
 * Called every 5 minutes by the keeper loop.
 */
export async function detectSignals(
  monitoredMarkets: string[] = STRATEGY_CONFIG.monitoredMarkets
): Promise<DriftSignalState> {
  const maxHistory = STRATEGY_CONFIG.signalHistorySize;
  const maxFundingHist = STRATEGY_CONFIG.fundingHistorySize;
  const snapshots = await fetchMarketSnapshots();

  const monitored = snapshots.filter((s) => monitoredMarkets.includes(s.market));

  const events: SignalEvent[] = [];

  const oiShift = detectOIShift(monitored, snapshotHistory);
  if (oiShift) events.push(oiShift);

  const liquidation = detectLiquidationCascade(monitored, snapshotHistory);
  if (liquidation) events.push(liquidation);

  const fundingVol = await detectFundingVolatility(monitoredMarkets);
  if (fundingVol) events.push(fundingVol);

  const spread = detectSpreadBlowout(monitored);
  if (spread) events.push(spread);

  // Update rolling history
  snapshotHistory.push(monitored);
  if (snapshotHistory.length > maxHistory) {
    snapshotHistory.shift();
  }

  // Update funding history with latest rates
  for (const snap of monitored) {
    const history = fundingHistory.get(snap.market) ?? [];
    history.push(snap.fundingRate24h);
    if (history.length > maxFundingHist) history.shift();
    fundingHistory.set(snap.market, history);
  }

  // Aggregate severity = max across all dimensions
  const severity = events.reduce(
    (max, e) => Math.max(max, e.severity) as SignalSeverity,
    SIGNAL_NONE as SignalSeverity
  );

  return {
    severity,
    events,
    timestamp: Date.now(),
    marketSnapshots: monitored,
  };
}

/**
 * Format signal state for logging.
 */
export function formatSignalState(state: DriftSignalState): string {
  const severityLabels = ["CLEAR", "LOW", "HIGH", "CRITICAL"];
  const label = severityLabels[state.severity];

  if (state.events.length === 0) {
    return `Signal: ${label} — no anomalies detected`;
  }

  const details = state.events
    .map((e) => `  [${severityLabels[e.severity]}] ${e.reason}`)
    .join("\n");

  return `Signal: ${label} (${state.events.length} anomalies)\n${details}`;
}
