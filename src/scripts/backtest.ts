import { DRIFT_DATA_API } from "../config/constants";
import { STRATEGY_CONFIG } from "../config/vault";
import { classifyVolRegime } from "../keeper/leverage-controller";
import { computeDriftRegime, VolRegime } from "../keeper/regime-engine";
import { SignalSeverity } from "../keeper/drift-signal-detector";

/**
 * Yogi Vault — Comparative Backtest
 *
 * Runs the same historical data through TWO strategies:
 * 1. Baseline (vol-only): static deployment, vol-only leverage
 * 2. Yogi (intelligent): regime-adaptive deployment based on vol + signals
 *
 * The "signals" are reconstructed from historical data:
 * - OI shift: daily change in long/short imbalance
 * - Spread blow-out: mark/oracle divergence
 * - Funding vol: rolling 7-day funding rate std dev
 *
 * All thresholds use STRATEGY_CONFIG.signalThresholds (same as live keeper).
 *
 * BACKTEST ASSUMPTIONS:
 * 1. Execution: All orders filled at oracle price (no slippage beyond configured bps)
 * 2. Funding: Daily funding rate earned uniformly (hourly rates summed)
 * 3. Leverage: Fixed throughout day (no intra-day rebalancing)
 * 4. Signals: Reconstructed from mark/oracle/funding data (not live anomaly detection)
 * 5. Lending: Constant 3% APY (reality varies by protocol)
 * 6. Vol regime: Based on funding vol (approximation of realized vol)
 */

interface FundingRecord {
  ts: number;
  marketIndex: number;
  symbol: string;
  fundingRate: string;
  fundingRateLong: string;
  fundingRateShort: string;
  oraclePriceTwap: string;
  markPriceTwap: string;
}

interface DailyResult {
  date: string;
  baselineEquity: number;
  yogiEquity: number;
  baselineReturn: number;
  yogiReturn: number;
  signalSeverity: number;
  deploymentPct: number;
  regime: string;
}

// --- Signal severity classification using config thresholds ---

function classifySeverity(
  value: number,
  thresholds: { low: number; high: number; critical: number }
): SignalSeverity {
  if (value >= thresholds.critical) return 3;
  if (value >= thresholds.high) return 2;
  if (value >= thresholds.low) return 1;
  return 0;
}

async function fetchFundingHistory(market: string): Promise<FundingRecord[]> {
  const res = await fetch(
    `${DRIFT_DATA_API}/market/${market}/fundingRates?limit=750`
  );
  if (!res.ok) throw new Error(`Failed: ${res.status}`);

  const body = (await res.json()) as {
    success: boolean;
    records: FundingRecord[];
  };
  if (!body.success || !body.records) throw new Error("No data");

  return body.records.sort((a, b) => a.ts - b.ts);
}

async function main() {
  console.log("Yogi Vault — Comparative Backtest (Baseline vs Yogi)\n");
  console.log("Baseline (Vol-Only): Static deployment, vol-only leverage");
  console.log("Yogi (Intelligent): Regime-adaptive deployment (vol + reconstructed signals)\n");

  const markets = STRATEGY_CONFIG.allowedMarkets.filter(
    (m) => !STRATEGY_CONFIG.excludeMarkets.includes(m)
  );

  console.log("Fetching funding rates...");
  const marketData = new Map<string, FundingRecord[]>();
  for (const market of markets) {
    try {
      const records = await fetchFundingHistory(market);
      marketData.set(market, records);
      console.log(`  ${market}: ${records.length} records`);
    } catch {
      console.log(`  ${market}: FAILED`);
    }
  }

  // Configuration
  const INITIAL_EQUITY = 100_000;
  const LENDING_PCT = STRATEGY_CONFIG.lendingFloorPct / 100;
  const BASIS_PCT = STRATEGY_CONFIG.basisTradePct / 100;
  const MAX_MARKETS = STRATEGY_CONFIG.maxMarketsSimultaneous;
  const MAX_PER_MARKET = STRATEGY_CONFIG.maxPositionPctPerMarket / 100;
  const LENDING_APY = 3;
  const LENDING_DAILY = LENDING_APY / 365;
  const PER_TRADE_FEE = Math.max(0, (STRATEGY_CONFIG.estimatedSlippageBps + STRATEGY_CONFIG.driftMakerFeeBps) / 10000);
  const ROUND_TRIP_COST = 2 * PER_TRADE_FEE;
  const MIN_FUNDING_BPS = STRATEGY_CONFIG.minAnnualizedFundingBps;

  // Group by day
  const allDates = new Set<string>();
  for (const [, records] of marketData) {
    for (const rec of records) {
      allDates.add(new Date(rec.ts * 1000).toISOString().slice(0, 10));
    }
  }
  const sortedDates = [...allDates].sort();

  // --- Simulate both strategies ---
  let baselineEquity = INITIAL_EQUITY;
  let yogiEquity = INITIAL_EQUITY;
  let baselinePeak = baselineEquity;
  let yogiPeak = yogiEquity;
  let baselineMaxDD = 0;
  let yogiMaxDD = 0;

  const results: DailyResult[] = [];
  const baselineReturns: number[] = [];
  const yogiReturns: number[] = [];

  // Rolling state for signal reconstruction
  const prevDayImbalance = new Map<string, number>();
  const fundingRateHistory: number[] = [];

  let baselinePositions = new Set<string>();
  let yogiPositions = new Set<string>();
  let baselineCosts = 0;
  let yogiCosts = 0;

  for (const date of sortedDates) {
    // --- Compute daily market data ---
    const marketDailyFunding = new Map<string, number>();
    let maxSpread = 0;
    let maxOIShift = 0;

    for (const [market, records] of marketData) {
      const dayRecords = records.filter(
        (r) => new Date(r.ts * 1000).toISOString().slice(0, 10) === date
      );
      if (dayRecords.length === 0) continue;

      const dailyRate = dayRecords.reduce((sum, r) => {
        const rate = parseFloat(r.fundingRateShort);
        const oracle = parseFloat(r.oraclePriceTwap);
        return sum + (oracle > 0 ? rate / oracle : 0);
      }, 0);

      marketDailyFunding.set(market, dailyRate);

      // Reconstruct signals from historical data
      // Mark/oracle spread
      const lastRecord = dayRecords[dayRecords.length - 1];
      const mark = parseFloat(lastRecord.markPriceTwap);
      const oracle = parseFloat(lastRecord.oraclePriceTwap);
      if (oracle > 0) {
        const spread = Math.abs((mark - oracle) / oracle) * 100;
        if (spread > maxSpread) maxSpread = spread;
      }

      // OI shift (approximate via funding rate change direction)
      const prevImbalance = prevDayImbalance.get(market) ?? 0;
      const currentImbalance = dailyRate * 10000; // Proxy: funding rate as imbalance
      const shift = Math.abs(currentImbalance - prevImbalance);
      if (shift > maxOIShift) maxOIShift = shift;
      prevDayImbalance.set(market, currentImbalance);
    }

    // Funding rate volatility (rolling 7-day std dev)
    const avgFunding = [...marketDailyFunding.values()].reduce((s, r) => s + r, 0) /
      Math.max(marketDailyFunding.size, 1);
    fundingRateHistory.push(avgFunding);
    if (fundingRateHistory.length > 7) fundingRateHistory.shift();

    let fundingVol = 0;
    if (fundingRateHistory.length >= 3) {
      const mean = fundingRateHistory.reduce((s, r) => s + r, 0) / fundingRateHistory.length;
      const variance = fundingRateHistory.reduce((s, r) => s + (r - mean) ** 2, 0) / fundingRateHistory.length;
      fundingVol = Math.sqrt(variance) * Math.sqrt(365) * 10000; // Annualized bps
    }

    // --- Compute signal severity ---
    const oiSeverity = classifySeverity(maxOIShift, STRATEGY_CONFIG.signalThresholds.oiShift);
    const spreadSeverity = classifySeverity(maxSpread, STRATEGY_CONFIG.signalThresholds.spread);
    const fundingVolSeverity = classifySeverity(fundingVol, STRATEGY_CONFIG.signalThresholds.fundingVol);
    const signalSeverity = Math.max(oiSeverity, spreadSeverity, fundingVolSeverity) as SignalSeverity;

    // --- Compute vol regime (approximate from funding vol as proxy) ---
    const volBps = Math.max(fundingVol, 2000); // Floor at 20%
    const volRegime = classifyVolRegime(volBps);

    // --- Baseline (vol-only) deployment: static vol-only leverage ---
    const baselineLeverage = STRATEGY_CONFIG.leverageByVolRegime[volRegime] ?? 1.0;
    const baselineDeployment = 100; // Baseline (vol-only) always deploys 100% of basis allocation

    // --- Yogi deployment: regime-adaptive (uses same matrices as live keeper) ---
    const yogiRegime = computeDriftRegime(volRegime, signalSeverity);
    const yogiDeployment = yogiRegime.deploymentPct;
    const yogiLeverage = yogiRegime.maxLeverage;

    // --- Select markets ---
    const eligibleMarkets = [...marketDailyFunding.entries()]
      .filter(([, rate]) => {
        const annualizedBps = Math.abs(rate) * 365 * 10000;
        return rate > 0 && annualizedBps >= MIN_FUNDING_BPS;
      })
      .sort((a, b) => b[1] - a[1])
      .slice(0, MAX_MARKETS);

    const newPositions = new Set(eligibleMarkets.map(([m]) => m));

    // --- Baseline (vol-only) P&L ---
    const baselineEntering = [...newPositions].filter((m) => !baselinePositions.has(m));
    const baselineExiting = [...baselinePositions].filter((m) => !newPositions.has(m));
    const baselinePerMarket = baselineEquity * BASIS_PCT * baselineLeverage / Math.max(newPositions.size, 1);
    const baselineTradeCost = (baselineEntering.length + baselineExiting.length) * baselinePerMarket * ROUND_TRIP_COST;
    baselineCosts += baselineTradeCost;

    const baselineLending = baselineEquity * LENDING_PCT * (LENDING_DAILY / 100);
    let baselineBasis = 0;
    if (eligibleMarkets.length > 0) {
      const alloc = Math.min(
        baselineEquity * BASIS_PCT * (baselineDeployment / 100) * baselineLeverage / eligibleMarkets.length,
        baselineEquity * MAX_PER_MARKET
      );
      for (const [, dailyRate] of eligibleMarkets) {
        baselineBasis += alloc * dailyRate;
      }
    }
    const baselineNet = baselineLending + baselineBasis - baselineTradeCost;
    const baselineReturnPct = baselineEquity > 0 ? (baselineNet / baselineEquity) * 100 : 0;
    baselineEquity += baselineNet;
    baselineReturns.push(baselineReturnPct);
    if (baselineEquity > baselinePeak) baselinePeak = baselineEquity;
    const baselineDD = (baselinePeak - baselineEquity) / baselinePeak;
    if (baselineDD > baselineMaxDD) baselineMaxDD = baselineDD;
    baselinePositions = newPositions;

    // --- Yogi P&L ---
    const yogiEntering = [...newPositions].filter((m) => !yogiPositions.has(m));
    const yogiExiting = [...yogiPositions].filter((m) => !newPositions.has(m));
    const yogiPerMarket = yogiEquity * BASIS_PCT * yogiLeverage / Math.max(newPositions.size, 1);
    const yogiTradeCost = (yogiEntering.length + yogiExiting.length) * yogiPerMarket * ROUND_TRIP_COST;
    yogiCosts += yogiTradeCost;

    const yogiLending = yogiEquity * LENDING_PCT * (LENDING_DAILY / 100);
    let yogiBasis = 0;
    if (eligibleMarkets.length > 0 && yogiDeployment > 0) {
      const alloc = Math.min(
        yogiEquity * BASIS_PCT * (yogiDeployment / 100) * yogiLeverage / eligibleMarkets.length,
        yogiEquity * MAX_PER_MARKET
      );
      for (const [, dailyRate] of eligibleMarkets) {
        yogiBasis += alloc * dailyRate;
      }
    }
    const yogiNet = yogiLending + yogiBasis - yogiTradeCost;
    const yogiReturnPct = yogiEquity > 0 ? (yogiNet / yogiEquity) * 100 : 0;
    yogiEquity += yogiNet;
    yogiReturns.push(yogiReturnPct);
    if (yogiEquity > yogiPeak) yogiPeak = yogiEquity;
    const yogiDD = (yogiPeak - yogiEquity) / yogiPeak;
    if (yogiDD > yogiMaxDD) yogiMaxDD = yogiDD;
    yogiPositions = newPositions;

    results.push({
      date,
      baselineEquity,
      yogiEquity,
      baselineReturn: baselineReturnPct,
      yogiReturn: yogiReturnPct,
      signalSeverity,
      deploymentPct: yogiDeployment,
      regime: `${volRegime}+${["CLEAR", "LOW", "HIGH", "CRITICAL"][signalSeverity]}`,
    });
  }

  // --- Results ---
  const totalDays = results.length;
  const baselineTotal = ((baselineEquity - INITIAL_EQUITY) / INITIAL_EQUITY) * 100;
  const yogiTotal = ((yogiEquity - INITIAL_EQUITY) / INITIAL_EQUITY) * 100;
  const baselineAPY = (baselineTotal / totalDays) * 365;
  const yogiAPY = (yogiTotal / totalDays) * 365;

  const avgBaseline = baselineReturns.reduce((a, b) => a + b, 0) / baselineReturns.length;
  const avgYogi = yogiReturns.reduce((a, b) => a + b, 0) / yogiReturns.length;
  const stdBaseline = Math.sqrt(baselineReturns.reduce((s, r) => s + (r - avgBaseline) ** 2, 0) / baselineReturns.length);
  const stdYogi = Math.sqrt(yogiReturns.reduce((s, r) => s + (r - avgYogi) ** 2, 0) / yogiReturns.length);
  const sharpeBaseline = stdBaseline > 0 ? (avgBaseline / stdBaseline) * Math.sqrt(365) : 0;
  const sharpeYogi = stdYogi > 0 ? (avgYogi / stdYogi) * Math.sqrt(365) : 0;

  // Signal distribution
  const signalDist = [0, 0, 0, 0];
  for (const r of results) signalDist[r.signalSeverity]++;

  console.log("\n════════════════════════════════════════════════════════");
  console.log("      COMPARATIVE BACKTEST: BASELINE vs YOGI");
  console.log("════════════════════════════════════════════════════════\n");
  console.log(`Period:         ${totalDays} days (${results[0]?.date} to ${results[results.length - 1]?.date})`);
  console.log(`Initial equity: $${INITIAL_EQUITY.toLocaleString()}\n`);

  console.log("                   BASELINE        YOGI");
  console.log("                  ──────────    ──────────");
  console.log(`  Final equity:   $${baselineEquity.toFixed(0).padStart(9)}    $${yogiEquity.toFixed(0).padStart(9)}`);
  console.log(`  Total return:   ${baselineTotal.toFixed(2).padStart(8)}%    ${yogiTotal.toFixed(2).padStart(8)}%`);
  console.log(`  Annualized:     ${baselineAPY.toFixed(2).padStart(8)}%    ${yogiAPY.toFixed(2).padStart(8)}%`);
  console.log(`  Max drawdown:   ${(baselineMaxDD * 100).toFixed(2).padStart(8)}%    ${(yogiMaxDD * 100).toFixed(2).padStart(8)}%`);
  console.log(`  Sharpe ratio:   ${sharpeBaseline.toFixed(2).padStart(9)}    ${sharpeYogi.toFixed(2).padStart(9)}`);
  console.log(`  Trading costs:  $${baselineCosts.toFixed(2).padStart(8)}    $${yogiCosts.toFixed(2).padStart(8)}`);

  // Signal distribution
  console.log(`\nYogi signal distribution:`);
  console.log(`  CLEAR:    ${signalDist[0]} days (${((signalDist[0] / totalDays) * 100).toFixed(0)}%)`);
  console.log(`  LOW:      ${signalDist[1]} days (${((signalDist[1] / totalDays) * 100).toFixed(0)}%)`);
  console.log(`  HIGH:     ${signalDist[2]} days (${((signalDist[2] / totalDays) * 100).toFixed(0)}%)`);
  console.log(`  CRITICAL: ${signalDist[3]} days (${((signalDist[3] / totalDays) * 100).toFixed(0)}%)`);

  // Equity curve comparison (every 5 days)
  console.log("\nEquity curve:");
  console.log("  Date        | Baseline     | Yogi         | Signal  | Deployment");
  console.log("  ──────────────────────────────────────────────────────────────────");
  for (let i = 0; i < results.length; i++) {
    if (i % 5 === 0 || i === results.length - 1) {
      const r = results[i];
      const baselinePct = ((r.baselineEquity - INITIAL_EQUITY) / INITIAL_EQUITY) * 100;
      const yogiPct = ((r.yogiEquity - INITIAL_EQUITY) / INITIAL_EQUITY) * 100;
      const signalLabel = ["CLEAR", "LOW", "HIGH", "CRIT"][r.signalSeverity];
      console.log(
        `  ${r.date} | $${r.baselineEquity.toFixed(0).padStart(9)} (${baselinePct >= 0 ? "+" : ""}${baselinePct.toFixed(1).padStart(5)}%) | ` +
        `$${r.yogiEquity.toFixed(0).padStart(9)} (${yogiPct >= 0 ? "+" : ""}${yogiPct.toFixed(1).padStart(5)}%) | ` +
        `${signalLabel.padStart(5)} | ${r.deploymentPct}%`
      );
    }
  }

  // Verdict
  console.log("\n════════════════════════════════════════════════════════");
  console.log(`Baseline APY: ${baselineAPY.toFixed(2)}% | Sharpe: ${sharpeBaseline.toFixed(2)} | Max DD: ${(baselineMaxDD * 100).toFixed(2)}%`);
  console.log(`Yogi APY:    ${yogiAPY.toFixed(2)}% | Sharpe: ${sharpeYogi.toFixed(2)} | Max DD: ${(yogiMaxDD * 100).toFixed(2)}%`);
  console.log("");

  if (yogiMaxDD < baselineMaxDD && yogiAPY > 0) {
    const ddImprovement = ((baselineMaxDD - yogiMaxDD) / baselineMaxDD * 100).toFixed(0);
    console.log(`Yogi advantage: ${ddImprovement}% lower max drawdown`);
  }
  if (sharpeYogi > sharpeBaseline) {
    console.log(`Yogi advantage: Better risk-adjusted returns (Sharpe ${sharpeYogi.toFixed(2)} vs ${sharpeBaseline.toFixed(2)})`);
  }
  if (yogiAPY < baselineAPY) {
    console.log(`Trade-off: Yogi sacrifices ${(baselineAPY - yogiAPY).toFixed(2)}% APY for better risk management`);
  }

  const meetsTarget = yogiAPY >= 10;
  console.log(`\nTarget APY: >=10% | Yogi: ${yogiAPY.toFixed(2)}% | ${meetsTarget ? "MEETS TARGET" : "BELOW TARGET"}`);
  console.log("════════════════════════════════════════════════════════");
}

main().catch(console.error);
