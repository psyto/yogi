import { DRIFT_DATA_API } from "../config/constants";
import { STRATEGY_CONFIG } from "../config/vault";

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
  lendingReturn: number; // % of total equity
  basisReturn: number; // % of total equity
  totalReturn: number; // % of total equity
  tradingCosts: number; // % of total equity
  netReturn: number; // % of total equity
  marketsTraded: string[];
  marketsBlocked: string[];
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
  console.log("🐻 Kuma Vault — Historical Backtest (Realistic)\n");
  console.log("Strategy: 30% lending floor + 70% basis trade (top 3 markets)");
  console.log("Leverage: dynamic by vol regime (0.5x-2x)");
  const orderType = STRATEGY_CONFIG.useLimitOrders ? "LIMIT (maker)" : "MARKET (taker)";
  const feeBps = STRATEGY_CONFIG.useLimitOrders ? STRATEGY_CONFIG.driftMakerFeeBps : STRATEGY_CONFIG.driftTakerFeeBps;
  console.log(`Orders: ${orderType} | Fee: ${feeBps} bps | Slippage: ${STRATEGY_CONFIG.estimatedSlippageBps} bps\n`);

  // Use allowed markets from config, filtered by excludeMarkets
  const markets = STRATEGY_CONFIG.allowedMarkets.filter(
    (m) => !STRATEGY_CONFIG.excludeMarkets.includes(m)
  );

  // Fetch all market data
  console.log("Fetching funding rates...");
  const marketData = new Map<string, FundingRecord[]>();
  for (const market of markets) {
    try {
      const records = await fetchFundingHistory(market);
      marketData.set(market, records);
      console.log(`  ${market}: ${records.length} records`);
    } catch (err) {
      console.log(`  ${market}: FAILED`);
    }
  }

  // Configuration
  const INITIAL_EQUITY = 100_000; // $100K starting capital
  const LENDING_PCT = STRATEGY_CONFIG.lendingFloorPct / 100; // 0.30
  const BASIS_PCT = STRATEGY_CONFIG.basisTradePct / 100; // 0.70
  const MAX_MARKETS = STRATEGY_CONFIG.maxMarketsSimultaneous; // 3
  const MAX_PER_MARKET = STRATEGY_CONFIG.maxPositionPctPerMarket / 100; // 0.40
  const LENDING_APY = 3; // Conservative 3% lending APY
  const LENDING_DAILY = LENDING_APY / 365; // ~0.0082% per day
  // Use maker or taker fees based on config
  const PER_TRADE_FEE = STRATEGY_CONFIG.useLimitOrders
    ? Math.max(0, (STRATEGY_CONFIG.estimatedSlippageBps + STRATEGY_CONFIG.driftMakerFeeBps) / 10000)
    : (STRATEGY_CONFIG.estimatedSlippageBps + STRATEGY_CONFIG.driftTakerFeeBps) / 10000;
  const ROUND_TRIP_COST = 2 * PER_TRADE_FEE;
  const MIN_FUNDING_BPS = STRATEGY_CONFIG.minAnnualizedFundingBps; // 500 bps = 5%
  const EXIT_RATE = STRATEGY_CONFIG.exitFundingBps / 10000; // -0.0005

  // Assume moderate leverage (current market is high vol → 0.5x-1x)
  const LEVERAGE = 1.0;

  // Group all records by day
  const allDates = new Set<string>();
  for (const [, records] of marketData) {
    for (const rec of records) {
      allDates.add(new Date(rec.ts * 1000).toISOString().slice(0, 10));
    }
  }
  const sortedDates = [...allDates].sort();

  // Simulate day by day
  let equity = INITIAL_EQUITY;
  let peakEquity = equity;
  let maxDrawdown = 0;
  const dailyResults: DailyResult[] = [];
  const dailyReturnsPct: number[] = [];
  let totalTradingCosts = 0;
  let positionChanges = 0;

  // Track which markets we're currently in
  let currentPositions = new Set<string>();

  for (const date of sortedDates) {
    // 1. Lending return (on 30% of equity)
    const lendingReturn = equity * LENDING_PCT * (LENDING_DAILY / 100);

    // 2. Evaluate each market's daily funding
    const marketDailyFunding = new Map<string, number>();
    const marketPositiveHours = new Map<string, number>();

    for (const [market, records] of marketData) {
      const dayRecords = records.filter(
        (r) => new Date(r.ts * 1000).toISOString().slice(0, 10) === date
      );
      if (dayRecords.length === 0) continue;

      // Sum hourly funding rates for the day (for short positions)
      // Raw fundingRateShort must be divided by oraclePriceTwap to get fractional rate
      const dailyRate = dayRecords.reduce(
        (sum, r) => {
          const rate = parseFloat(r.fundingRateShort);
          const oracle = parseFloat(r.oraclePriceTwap);
          return sum + (oracle > 0 ? rate / oracle : 0);
        },
        0
      );
      const positiveHours = dayRecords.filter(
        (r) => parseFloat(r.fundingRateShort) > 0
      ).length;

      marketDailyFunding.set(market, dailyRate);
      marketPositiveHours.set(market, positiveHours);
    }

    // 3. Rank markets by daily funding (positive only, annualized > 5%)
    const eligibleMarkets = [...marketDailyFunding.entries()]
      .filter(([, rate]) => {
        const annualizedBps = Math.abs(rate) * 365 * 10000;
        return rate > 0 && annualizedBps >= MIN_FUNDING_BPS;
      })
      .sort((a, b) => b[1] - a[1])
      .slice(0, MAX_MARKETS);

    // 4. Check for position changes (incurs trading costs)
    const newPositions = new Set(eligibleMarkets.map(([m]) => m));
    const entering = [...newPositions].filter((m) => !currentPositions.has(m));
    const exiting = [...currentPositions].filter((m) => !newPositions.has(m));
    positionChanges += entering.length + exiting.length;

    // Trading costs for position changes
    const perMarketAllocation = equity * BASIS_PCT * LEVERAGE / Math.max(newPositions.size, 1);
    const tradingCosts =
      (entering.length + exiting.length) * perMarketAllocation * ROUND_TRIP_COST;
    totalTradingCosts += tradingCosts;

    currentPositions = newPositions;

    // 5. Compute basis return
    // Each market gets equal share of the 70% basis pool, scaled by leverage
    let basisReturn = 0;
    const marketsTraded: string[] = [];
    const marketsBlocked: string[] = [];

    if (eligibleMarkets.length > 0) {
      const allocationPerMarket = Math.min(
        equity * BASIS_PCT * LEVERAGE / eligibleMarkets.length,
        equity * MAX_PER_MARKET
      );

      for (const [market, dailyRate] of eligibleMarkets) {
        // Daily return = position_size × daily_funding_rate
        // dailyRate is sum of hourly rates (e.g., 24 × 0.0005 = 0.012 = 1.2%)
        const marketReturn = allocationPerMarket * dailyRate;
        basisReturn += marketReturn;
        marketsTraded.push(market);
      }
    }

    // Markets that were blocked
    for (const [market, rate] of marketDailyFunding) {
      if (!marketsTraded.includes(market)) {
        marketsBlocked.push(
          `${market}(${rate > 0 ? "thin" : "neg"})`
        );
      }
    }

    // 6. Net daily P&L
    const netReturn = lendingReturn + basisReturn - tradingCosts;
    equity += netReturn;

    if (equity > peakEquity) peakEquity = equity;
    const dd = (peakEquity - equity) / peakEquity;
    if (dd > maxDrawdown) maxDrawdown = dd;

    const dailyReturnPct = (netReturn / (equity - netReturn)) * 100;
    dailyReturnsPct.push(dailyReturnPct);

    dailyResults.push({
      date,
      lendingReturn,
      basisReturn,
      totalReturn: lendingReturn + basisReturn,
      tradingCosts,
      netReturn,
      marketsTraded,
      marketsBlocked,
    });
  }

  // Results
  const totalDays = dailyResults.length;
  const totalReturnPct = ((equity - INITIAL_EQUITY) / INITIAL_EQUITY) * 100;
  const annualizedAPY = (totalReturnPct / totalDays) * 365;
  const avgDailyReturn =
    dailyReturnsPct.reduce((a, b) => a + b, 0) / dailyReturnsPct.length;
  const stdDaily = Math.sqrt(
    dailyReturnsPct.reduce(
      (sum, r) => sum + (r - avgDailyReturn) ** 2,
      0
    ) / dailyReturnsPct.length
  );
  const sharpe = stdDaily > 0 ? (avgDailyReturn / stdDaily) * Math.sqrt(365) : 0;

  const tradingDays = dailyResults.filter((d) => d.marketsTraded.length > 0).length;
  const idleDays = totalDays - tradingDays;

  console.log("\n════════════════════════════════════════");
  console.log("           BACKTEST RESULTS");
  console.log("════════════════════════════════════════\n");
  console.log(`Period:            ${totalDays} days (${sortedDates[0]} to ${sortedDates[sortedDates.length - 1]})`);
  console.log(`Starting equity:   $${INITIAL_EQUITY.toLocaleString()}`);
  console.log(`Ending equity:     $${equity.toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ",")}`);
  console.log(`Total return:      ${totalReturnPct.toFixed(2)}%`);
  console.log(`Annualized APY:    ${annualizedAPY.toFixed(2)}%`);
  console.log(`Max drawdown:      ${(maxDrawdown * 100).toFixed(2)}%`);
  console.log(`Sharpe ratio:      ${sharpe.toFixed(2)}`);
  console.log(`Trading days:      ${tradingDays}/${totalDays} (${((tradingDays / totalDays) * 100).toFixed(0)}%)`);
  console.log(`Idle days:         ${idleDays} (${((idleDays / totalDays) * 100).toFixed(0)}%)`);
  console.log(`Position changes:  ${positionChanges}`);
  console.log(`Total costs:       $${totalTradingCosts.toFixed(2)} (${((totalTradingCosts / INITIAL_EQUITY) * 100).toFixed(3)}% of initial)`);
  console.log(`Leverage:          ${LEVERAGE}x`);

  // Breakdown
  const totalLending = dailyResults.reduce((s, d) => s + d.lendingReturn, 0);
  const totalBasis = dailyResults.reduce((s, d) => s + d.basisReturn, 0);
  console.log(`\nReturn breakdown:`);
  console.log(`  Lending floor:   $${totalLending.toFixed(2)} (${((totalLending / INITIAL_EQUITY) * 100).toFixed(2)}%)`);
  console.log(`  Basis alpha:     $${totalBasis.toFixed(2)} (${((totalBasis / INITIAL_EQUITY) * 100).toFixed(2)}%)`);
  console.log(`  Trading costs:   -$${totalTradingCosts.toFixed(2)}`);

  // Daily equity curve (sample every 5 days)
  console.log("\nEquity curve:");
  let runningEquity = INITIAL_EQUITY;
  for (let i = 0; i < dailyResults.length; i++) {
    runningEquity += dailyResults[i].netReturn;
    if (i % 5 === 0 || i === dailyResults.length - 1) {
      const pct = ((runningEquity - INITIAL_EQUITY) / INITIAL_EQUITY) * 100;
      const bar = pct >= 0
        ? "█".repeat(Math.min(Math.round(pct * 2), 50))
        : "░".repeat(Math.min(Math.round(Math.abs(pct) * 2), 50));
      console.log(
        `  ${dailyResults[i].date} | $${runningEquity.toFixed(0).padStart(9)} | ${pct >= 0 ? "+" : ""}${pct.toFixed(2).padStart(7)}% ${bar}`
      );
    }
  }

  // Market frequency
  console.log("\nMarket selection frequency:");
  const marketCount = new Map<string, number>();
  for (const d of dailyResults) {
    for (const m of d.marketsTraded) {
      marketCount.set(m, (marketCount.get(m) ?? 0) + 1);
    }
  }
  [...marketCount.entries()]
    .sort((a, b) => b[1] - a[1])
    .forEach(([market, count]) => {
      console.log(
        `  ${market.padEnd(16)} ${count} days (${((count / totalDays) * 100).toFixed(0)}%)`
      );
    });

  // Verdict
  console.log("\n════════════════════════════════════════");
  console.log(`Target APY:   ≥10%`);
  console.log(`Achieved APY: ${annualizedAPY.toFixed(2)}%`);
  console.log(`Verdict:      ${annualizedAPY >= 10 ? "MEETS TARGET ✓" : annualizedAPY > 0 ? "POSITIVE BUT BELOW TARGET" : "NEGATIVE — STRATEGY WOULD LOSE MONEY"}`);
  console.log(`Max DD:       ${(maxDrawdown * 100).toFixed(2)}% (limit: 3% reduce / 5% close)`);
  console.log("════════════════════════════════════════");
}

main().catch(console.error);
