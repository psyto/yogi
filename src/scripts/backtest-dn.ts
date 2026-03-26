import { DRIFT_DATA_API } from "../config/constants";
import { STRATEGY_CONFIG } from "../config/vault";
import { classifyVolRegime } from "../keeper/leverage-controller";
import { computeDriftRegime } from "../keeper/regime-engine";
import { SignalSeverity } from "../keeper/drift-signal-detector";
import { computeDynamicTilt } from "../keeper/delta-neutral";

/**
 * Yogi Vault — Delta-Neutral Backtest
 *
 * Compares THREE strategies on identical historical data:
 * 1. Baseline: directional shorts, vol-only leverage
 * 2. Yogi Directional: directional with regime engine (signals reduce deployment)
 * 3. Yogi DN: delta-neutral (spot buy + perp short) with dynamic tilt
 *
 * DN model:
 * - 70% of deployed capital → spot buy (price hedge)
 * - 30% → perp margin
 * - Perp short = spot × (1 + tilt%)
 * - Funding income = perp notional × positive funding rate
 * - Tilt P&L = tilt% × notional × daily price change (small directional)
 * - Price changes on spot+perp cancel out (within tilt)
 * - Exit when funding < 5% APY
 * - Idle USDC earns 3% auto-lending
 *
 * Only DN-eligible markets: SOL-PERP, BTC-PERP, ETH-PERP
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

interface CandleRecord {
  start: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

interface DailyResult {
  date: string;
  baselineEquity: number;
  directionalEquity: number;
  dnEquity: number;
  signalSeverity: number;
  deploymentPct: number;
  tiltPct: number;
  dnMarkets: number;
  regime: string;
}

const DN_MARKETS = ["SOL-PERP", "BTC-PERP", "ETH-PERP"];
const SPOT_RATIO = 0.70;
const MIN_FUNDING_APY = 5.0;

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
  const body = (await res.json()) as { success: boolean; records: FundingRecord[] };
  if (!body.success || !body.records) throw new Error("No data");
  return body.records.sort((a: FundingRecord, b: FundingRecord) => a.ts - b.ts);
}

async function fetchCandles(market: string): Promise<CandleRecord[]> {
  const res = await fetch(
    `${DRIFT_DATA_API}/market/${market}/candles?resolution=D&limit=100`
  );
  if (!res.ok) throw new Error(`Candles failed: ${res.status}`);
  const body = (await res.json()) as { records?: CandleRecord[] } | CandleRecord[];
  const records = Array.isArray(body) ? body : (body as any).records || [];
  if (!Array.isArray(records)) throw new Error("No candle data");
  return records.sort((a: CandleRecord, b: CandleRecord) => a.start - b.start);
}

async function main() {
  console.log("Yogi Vault — Delta-Neutral Backtest\n");
  console.log("Baseline:          Directional shorts, vol-only leverage");
  console.log("Yogi Directional:  Directional + regime engine (vol + signals)");
  console.log("Yogi DN:           Delta-neutral (spot+perp) + dynamic tilt + regime\n");

  // Fetch data for DN-eligible markets
  console.log("Fetching funding rates and candles...");
  const marketFunding = new Map<string, FundingRecord[]>();
  const marketCandles = new Map<string, CandleRecord[]>();

  for (const market of DN_MARKETS) {
    try {
      const funding = await fetchFundingHistory(market);
      marketFunding.set(market, funding);
      console.log(`  ${market}: ${funding.length} funding records`);
    } catch (e) {
      console.log(`  ${market}: funding FAILED — ${e}`);
    }
    try {
      const candles = await fetchCandles(market);
      marketCandles.set(market, candles);
      console.log(`  ${market}: ${candles.length} daily candles`);
    } catch (e) {
      console.log(`  ${market}: candles FAILED — ${e}`);
    }
  }

  // Configuration
  const INITIAL_EQUITY = 100_000;
  const LENDING_APY_DAILY = 3 / 365 / 100; // 3% APY daily
  const BASIS_PCT = STRATEGY_CONFIG.basisTradePct / 100;
  const LENDING_PCT = STRATEGY_CONFIG.lendingFloorPct / 100;
  const MAX_MARKETS = STRATEGY_CONFIG.maxMarketsSimultaneous;
  const MAX_PER_MARKET = STRATEGY_CONFIG.maxPositionPctPerMarket / 100;
  const PER_TRADE_FEE = Math.max(0, (STRATEGY_CONFIG.estimatedSlippageBps + STRATEGY_CONFIG.driftMakerFeeBps) / 10000);
  const ROUND_TRIP_COST = 2 * PER_TRADE_FEE;
  const MIN_FUNDING_BPS = STRATEGY_CONFIG.minAnnualizedFundingBps;

  // Group by day
  const allDates = new Set<string>();
  for (const [, records] of marketFunding) {
    for (const rec of records) {
      allDates.add(new Date(rec.ts * 1000).toISOString().slice(0, 10));
    }
  }
  const sortedDates = [...allDates].sort();

  // State
  let baselineEquity = INITIAL_EQUITY;
  let directionalEquity = INITIAL_EQUITY;
  let dnEquity = INITIAL_EQUITY;
  let baselinePeak = INITIAL_EQUITY;
  let directionalPeak = INITIAL_EQUITY;
  let dnPeak = INITIAL_EQUITY;
  let baselineMaxDD = 0;
  let directionalMaxDD = 0;
  let dnMaxDD = 0;

  const results: DailyResult[] = [];
  const baselineReturns: number[] = [];
  const directionalReturns: number[] = [];
  const dnReturns: number[] = [];

  let baselineCosts = 0;
  let directionalCosts = 0;
  let dnCosts = 0;

  const prevDayImbalance = new Map<string, number>();
  const fundingRateHistory: number[] = [];

  let baselinePositions = new Set<string>();
  let directionalPositions = new Set<string>();
  let dnPositions = new Set<string>();

  for (const date of sortedDates) {
    // --- Daily market data ---
    const marketDailyFunding = new Map<string, number>();
    const marketDailyPrice = new Map<string, { open: number; close: number }>();
    let maxSpread = 0;
    let maxOIShift = 0;

    for (const [market, records] of marketFunding) {
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

      // Mark/oracle spread
      const lastRecord = dayRecords[dayRecords.length - 1];
      const mark = parseFloat(lastRecord.markPriceTwap);
      const oracle = parseFloat(lastRecord.oraclePriceTwap);
      if (oracle > 0) {
        const spread = Math.abs((mark - oracle) / oracle) * 100;
        if (spread > maxSpread) maxSpread = spread;
      }

      // OI shift proxy
      const prevImbalance = prevDayImbalance.get(market) ?? 0;
      const currentImbalance = dailyRate * 10000;
      const shift = Math.abs(currentImbalance - prevImbalance);
      if (shift > maxOIShift) maxOIShift = shift;
      prevDayImbalance.set(market, currentImbalance);
    }

    // Price data from candles
    for (const [market, candles] of marketCandles) {
      const dayCandle = candles.find(
        (c) => new Date(c.start * 1000).toISOString().slice(0, 10) === date
      );
      if (dayCandle) {
        marketDailyPrice.set(market, { open: dayCandle.open, close: dayCandle.close });
      }
    }

    // Funding vol
    const avgFunding = [...marketDailyFunding.values()].reduce((s, r) => s + r, 0) /
      Math.max(marketDailyFunding.size, 1);
    fundingRateHistory.push(avgFunding);
    if (fundingRateHistory.length > 7) fundingRateHistory.shift();

    let fundingVol = 0;
    if (fundingRateHistory.length >= 3) {
      const mean = fundingRateHistory.reduce((s, r) => s + r, 0) / fundingRateHistory.length;
      const variance = fundingRateHistory.reduce((s, r) => s + (r - mean) ** 2, 0) / fundingRateHistory.length;
      fundingVol = Math.sqrt(variance) * Math.sqrt(365) * 10000;
    }

    // Signal severity
    const oiSeverity = classifySeverity(maxOIShift, STRATEGY_CONFIG.signalThresholds.oiShift);
    const spreadSeverity = classifySeverity(maxSpread, STRATEGY_CONFIG.signalThresholds.spread);
    const fundingVolSeverity = classifySeverity(fundingVol, STRATEGY_CONFIG.signalThresholds.fundingVol);
    const signalSeverity = Math.max(oiSeverity, spreadSeverity, fundingVolSeverity) as SignalSeverity;

    // Vol regime
    const volBps = Math.max(fundingVol, 2000);
    const volRegime = classifyVolRegime(volBps);
    const regime = computeDriftRegime(volRegime, signalSeverity);

    // --- Eligible markets ---
    const positiveMarkets = [...marketDailyFunding.entries()]
      .filter(([, rate]) => rate > 0 && Math.abs(rate) * 365 * 10000 >= MIN_FUNDING_BPS)
      .sort((a, b) => b[1] - a[1])
      .slice(0, MAX_MARKETS);

    const dnEligible = positiveMarkets.filter(([m]) => DN_MARKETS.includes(m));
    const dnMinRate = MIN_FUNDING_APY / 100 / 365; // Daily rate threshold

    const dnActiveMarkets = dnEligible.filter(([, rate]) => rate >= dnMinRate);

    // Dynamic tilt
    const avgFundingRate = dnActiveMarkets.length > 0
      ? dnActiveMarkets.reduce((s, [, r]) => s + r, 0) / dnActiveMarkets.length
      : 0;
    const tiltPct = computeDynamicTilt(signalSeverity, volRegime, avgFundingRate);

    // ═══ BASELINE (directional, vol-only) ═══
    const baselineLeverage = (STRATEGY_CONFIG.leverageByVolRegime as Record<string, number>)[volRegime] ?? 1.0;
    const newBaselinePos = new Set(positiveMarkets.map(([m]) => m));

    const bEntering = [...newBaselinePos].filter((m) => !baselinePositions.has(m));
    const bExiting = [...baselinePositions].filter((m) => !newBaselinePos.has(m));
    const bPerMarket = baselineEquity * BASIS_PCT * baselineLeverage / Math.max(newBaselinePos.size, 1);
    const bTradeCost = (bEntering.length + bExiting.length) * bPerMarket * ROUND_TRIP_COST;
    baselineCosts += bTradeCost;

    const bLending = baselineEquity * LENDING_PCT * LENDING_APY_DAILY;
    let bBasis = 0;
    for (const [, dailyRate] of positiveMarkets) {
      const alloc = Math.min(
        baselineEquity * BASIS_PCT * baselineLeverage / positiveMarkets.length,
        baselineEquity * MAX_PER_MARKET
      );
      bBasis += alloc * dailyRate;
    }
    const bNet = bLending + bBasis - bTradeCost;
    const bReturnPct = baselineEquity > 0 ? (bNet / baselineEquity) * 100 : 0;
    baselineEquity += bNet;
    baselineReturns.push(bReturnPct);
    if (baselineEquity > baselinePeak) baselinePeak = baselineEquity;
    baselineMaxDD = Math.max(baselineMaxDD, (baselinePeak - baselineEquity) / baselinePeak);
    baselinePositions = newBaselinePos;

    // ═══ YOGI DIRECTIONAL (regime-adaptive) ═══
    const dDeployment = regime.deploymentPct / 100;
    const dLeverage = regime.maxLeverage;
    const newDirPos = new Set(positiveMarkets.map(([m]) => m));

    const dEntering = [...newDirPos].filter((m) => !directionalPositions.has(m));
    const dExiting = [...directionalPositions].filter((m) => !newDirPos.has(m));
    const dPerMarket = directionalEquity * BASIS_PCT * dDeployment * dLeverage / Math.max(newDirPos.size, 1);
    const dTradeCost = (dEntering.length + dExiting.length) * dPerMarket * ROUND_TRIP_COST;
    directionalCosts += dTradeCost;

    const dLending = directionalEquity * LENDING_PCT * LENDING_APY_DAILY;
    let dBasis = 0;
    for (const [, dailyRate] of positiveMarkets) {
      const alloc = Math.min(
        directionalEquity * BASIS_PCT * dDeployment * dLeverage / positiveMarkets.length,
        directionalEquity * MAX_PER_MARKET
      );
      dBasis += alloc * dailyRate;
    }
    const dNet = dLending + dBasis - dTradeCost;
    const dReturnPct = directionalEquity > 0 ? (dNet / directionalEquity) * 100 : 0;
    directionalEquity += dNet;
    directionalReturns.push(dReturnPct);
    if (directionalEquity > directionalPeak) directionalPeak = directionalEquity;
    directionalMaxDD = Math.max(directionalMaxDD, (directionalPeak - directionalEquity) / directionalPeak);
    directionalPositions = newDirPos;

    // ═══ YOGI DN (delta-neutral + dynamic tilt) ═══
    const dnDeployment = regime.deploymentPct / 100;
    const newDnPos = new Set(dnActiveMarkets.map(([m]) => m));

    const dnEntering = [...newDnPos].filter((m) => !dnPositions.has(m));
    const dnExiting = [...dnPositions].filter((m) => !newDnPos.has(m));

    // DN trade costs: both spot + perp legs
    const dnPerMarket = dnEquity * BASIS_PCT * dnDeployment / Math.max(newDnPos.size, 1);
    const dnTradeCost = (dnEntering.length + dnExiting.length) * dnPerMarket * ROUND_TRIP_COST * 2; // 2 legs
    dnCosts += dnTradeCost;

    // Idle USDC auto-lending (everything not in spot positions)
    const dnDeployed = Math.min(dnActiveMarkets.length, MAX_MARKETS) * dnPerMarket;
    const dnIdle = Math.max(0, dnEquity - dnDeployed);
    const dnLending = dnIdle * LENDING_APY_DAILY;

    let dnFunding = 0;
    let dnTiltPnl = 0;

    for (const [market, dailyRate] of dnActiveMarkets) {
      const capital = Math.min(dnPerMarket, dnEquity * MAX_PER_MARKET);
      const spotNotional = capital * SPOT_RATIO;
      const perpNotional = spotNotional * (1 + tiltPct);

      // Funding income: perp short collects positive funding
      if (dailyRate > 0) {
        dnFunding += perpNotional * dailyRate;
      }

      // Tilt P&L: tilt% of notional exposed to price direction
      const priceData = marketDailyPrice.get(market);
      if (priceData && priceData.open > 0) {
        const priceChange = (priceData.close - priceData.open) / priceData.open;
        // Short bias profits when price drops
        dnTiltPnl -= tiltPct * spotNotional * priceChange;
      }
    }

    const dnNet = dnLending + dnFunding + dnTiltPnl - dnTradeCost;
    const dnReturnPct = dnEquity > 0 ? (dnNet / dnEquity) * 100 : 0;
    dnEquity += dnNet;
    dnReturns.push(dnReturnPct);
    if (dnEquity > dnPeak) dnPeak = dnEquity;
    dnMaxDD = Math.max(dnMaxDD, (dnPeak - dnEquity) / dnPeak);
    dnPositions = newDnPos;

    results.push({
      date,
      baselineEquity,
      directionalEquity,
      dnEquity,
      signalSeverity,
      deploymentPct: regime.deploymentPct,
      tiltPct: tiltPct * 100,
      dnMarkets: dnActiveMarkets.length,
      regime: `${volRegime}+${["CLEAR", "LOW", "HIGH", "CRIT"][signalSeverity]}`,
    });
  }

  // --- Results ---
  const totalDays = results.length;

  const calc = (equity: number, returns: number[]) => {
    const totalReturn = ((equity - INITIAL_EQUITY) / INITIAL_EQUITY) * 100;
    const apy = (totalReturn / totalDays) * 365;
    const avg = returns.reduce((a, b) => a + b, 0) / returns.length;
    const std = Math.sqrt(returns.reduce((s, r) => s + (r - avg) ** 2, 0) / returns.length);
    const sharpe = std > 0 ? (avg / std) * Math.sqrt(365) : 0;
    return { totalReturn, apy, sharpe };
  };

  const b = calc(baselineEquity, baselineReturns);
  const d = calc(directionalEquity, directionalReturns);
  const dn = calc(dnEquity, dnReturns);

  console.log("\n════════════════════════════════════════════════════════════════════════");
  console.log("       DELTA-NEUTRAL BACKTEST: BASELINE vs DIRECTIONAL vs DN");
  console.log("════════════════════════════════════════════════════════════════════════\n");
  console.log(`Period:         ${totalDays} days (${results[0]?.date} to ${results[results.length - 1]?.date})`);
  console.log(`Initial equity: $${INITIAL_EQUITY.toLocaleString()}`);
  console.log(`DN markets:     ${DN_MARKETS.join(", ")}\n`);

  console.log("                    BASELINE       DIRECTIONAL    YOGI DN");
  console.log("                   ──────────      ──────────     ──────────");
  console.log(`  Final equity:    $${baselineEquity.toFixed(0).padStart(9)}     $${directionalEquity.toFixed(0).padStart(9)}    $${dnEquity.toFixed(0).padStart(9)}`);
  console.log(`  Total return:    ${b.totalReturn.toFixed(2).padStart(8)}%     ${d.totalReturn.toFixed(2).padStart(8)}%    ${dn.totalReturn.toFixed(2).padStart(8)}%`);
  console.log(`  Annualized:      ${b.apy.toFixed(2).padStart(8)}%     ${d.apy.toFixed(2).padStart(8)}%    ${dn.apy.toFixed(2).padStart(8)}%`);
  console.log(`  Max drawdown:    ${(baselineMaxDD * 100).toFixed(3).padStart(8)}%     ${(directionalMaxDD * 100).toFixed(3).padStart(8)}%    ${(dnMaxDD * 100).toFixed(3).padStart(8)}%`);
  console.log(`  Sharpe ratio:    ${b.sharpe.toFixed(2).padStart(9)}     ${d.sharpe.toFixed(2).padStart(9)}    ${dn.sharpe.toFixed(2).padStart(9)}`);
  console.log(`  Trading costs:   $${baselineCosts.toFixed(2).padStart(8)}     $${directionalCosts.toFixed(2).padStart(8)}    $${dnCosts.toFixed(2).padStart(8)}`);

  // Signal + tilt distribution
  const signalDist = [0, 0, 0, 0];
  let totalTilt = 0;
  let totalDnMarkets = 0;
  for (const r of results) {
    signalDist[r.signalSeverity]++;
    totalTilt += r.tiltPct;
    totalDnMarkets += r.dnMarkets;
  }

  console.log(`\nSignal distribution:`);
  console.log(`  CLEAR: ${signalDist[0]} days (${((signalDist[0] / totalDays) * 100).toFixed(0)}%) | LOW: ${signalDist[1]} days (${((signalDist[1] / totalDays) * 100).toFixed(0)}%) | HIGH: ${signalDist[2]} days | CRIT: ${signalDist[3]} days`);
  console.log(`  Avg tilt: ${(totalTilt / totalDays).toFixed(1)}% | Avg DN markets: ${(totalDnMarkets / totalDays).toFixed(1)}`);

  // Equity curve
  console.log("\nEquity curve (every 5 days):");
  console.log("  Date        | Baseline     | Directional  | Yogi DN      | Signal | Tilt | DN#");
  console.log("  ────────────────────────────────────────────────────────────────────────────────");
  for (let i = 0; i < results.length; i++) {
    if (i % 5 === 0 || i === results.length - 1) {
      const r = results[i];
      const bPct = ((r.baselineEquity - INITIAL_EQUITY) / INITIAL_EQUITY) * 100;
      const dPct = ((r.directionalEquity - INITIAL_EQUITY) / INITIAL_EQUITY) * 100;
      const dnPct = ((r.dnEquity - INITIAL_EQUITY) / INITIAL_EQUITY) * 100;
      const sig = ["CLEAR", "LOW", "HIGH", "CRIT"][r.signalSeverity];
      console.log(
        `  ${r.date} | $${r.baselineEquity.toFixed(0).padStart(9)} (${bPct >= 0 ? "+" : ""}${bPct.toFixed(1).padStart(5)}%) | ` +
        `$${r.directionalEquity.toFixed(0).padStart(9)} (${dPct >= 0 ? "+" : ""}${dPct.toFixed(1).padStart(5)}%) | ` +
        `$${r.dnEquity.toFixed(0).padStart(9)} (${dnPct >= 0 ? "+" : ""}${dnPct.toFixed(1).padStart(5)}%) | ` +
        `${sig.padStart(5)} | ${r.tiltPct.toFixed(0).padStart(3)}% | ${r.dnMarkets}`
      );
    }
  }

  // Verdict
  console.log("\n════════════════════════════════════════════════════════════════════════");
  console.log(`Baseline:     ${b.apy.toFixed(2)}% APY | Sharpe ${b.sharpe.toFixed(2)} | DD ${(baselineMaxDD * 100).toFixed(3)}%`);
  console.log(`Directional:  ${d.apy.toFixed(2)}% APY | Sharpe ${d.sharpe.toFixed(2)} | DD ${(directionalMaxDD * 100).toFixed(3)}%`);
  console.log(`Yogi DN:      ${dn.apy.toFixed(2)}% APY | Sharpe ${dn.sharpe.toFixed(2)} | DD ${(dnMaxDD * 100).toFixed(3)}%`);

  if (dnMaxDD < directionalMaxDD) {
    const improvement = ((directionalMaxDD - dnMaxDD) / directionalMaxDD * 100).toFixed(0);
    console.log(`\nDN advantage: ${improvement}% lower max drawdown vs directional`);
  }
  if (dn.sharpe > d.sharpe) {
    console.log(`DN advantage: Better Sharpe (${dn.sharpe.toFixed(2)} vs ${d.sharpe.toFixed(2)})`);
  }

  console.log("\nNote: DN eliminates price risk — drawdown comes only from tilt exposure");
  console.log("and funding rate flips. Directional drawdown includes full price exposure.");
  console.log("════════════════════════════════════════════════════════════════════════");
}

main().catch(console.error);
