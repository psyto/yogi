import { Connection, Keypair } from "@solana/web3.js";
import {
  DriftClient,
  Wallet,
} from "@drift-labs/sdk";
import { getConnection, loadKeypair, sleep } from "../utils/helpers";
import { STRATEGY_CONFIG } from "../config/vault";
import { DRIFT_PROGRAM_ID } from "../config/constants";
import {
  fetchAllFundingRates,
  rankMarketsByFunding,
  FundingRateData,
} from "./funding-scanner";
import {
  computeTargetAllocations,
  openBasisPosition,
  closeBasisPosition,
  shouldExitPosition,
  BasisPosition,
} from "./position-manager";
import { evaluateTradeEconomics, passesCostGate } from "./cost-calculator";
import {
  fetchReferenceVol,
  computeTargetLeverage,
  LeverageState,
  classifyVolRegime,
} from "./leverage-controller";
import { computeHealthState, computeDrawdown } from "./health-monitor";
import {
  fetchMarketImbalances,
  rankByImbalance,
  getTradeDirection,
  MarketImbalance,
} from "./imbalance-detector";
import {
  detectSignals,
  formatSignalState,
  DriftSignalState,
  SIGNAL_NONE,
} from "./drift-signal-detector";
import {
  computeDriftRegime,
  shouldTriggerEmergencyRebalance,
  formatRegime,
  DriftRegime,
} from "./regime-engine";

// --- Global State ---
const activePositions: BasisPosition[] = [];
let peakEquity = 0;
let currentLeverage: LeverageState | undefined;
let latestImbalances: MarketImbalance[] = [];
let currentSignals: DriftSignalState = {
  severity: SIGNAL_NONE,
  events: [],
  timestamp: Date.now(),
  marketSnapshots: [],
};
let currentRegime: DriftRegime | undefined;

async function initDriftClient(
  connection: Connection,
  keypair: Keypair
): Promise<DriftClient> {
  const wallet = new Wallet(keypair);

  const driftClient = new DriftClient({
    connection,
    wallet,
    programID: DRIFT_PROGRAM_ID,
    activeSubAccountId: 0,
    subAccountIds: [0],
    accountSubscription: {
      type: "websocket",
    },
    includeDelegates: false,
    skipLoadUsers: false,
  });

  console.log("Subscribing to Drift...");
  await driftClient.subscribe();
  console.log("Subscribed. Adding user...");
  await driftClient.addUser(0);
  console.log("User added. Checking...");

  try {
    const user = driftClient.getUser();
    console.log(`User found: ${user.getUserAccountPublicKey().toBase58()}`);
  } catch (e) {
    console.error("User check failed:", e);
  }

  return driftClient;
}

async function updateLeverage(): Promise<void> {
  try {
    const volBps = await fetchReferenceVol();
    currentLeverage = computeTargetLeverage(volBps);
    console.log(
      `Vol: ${(currentLeverage.currentVol * 100).toFixed(1)}% (${currentLeverage.regime} regime)`
    );
  } catch (err) {
    console.error("Failed to update leverage:", err);
  }
}

/**
 * YOGI-SPECIFIC: Run signal detection and update regime.
 * This is the intelligence layer that makes Yogi's risk management proactive.
 */
async function runSignalDetection(): Promise<boolean> {
  console.log("\n--- Signal Detection ---");
  try {
    currentSignals = await detectSignals(STRATEGY_CONFIG.monitoredMarkets);
    console.log(formatSignalState(currentSignals));

    // Compute unified regime from vol + signals
    const volRegime = currentLeverage
      ? currentLeverage.regime
      : classifyVolRegime(3000); // Default to 30% vol if unknown

    const previousRegime = currentRegime;
    currentRegime = computeDriftRegime(volRegime, currentSignals.severity);
    console.log(`Regime: ${formatRegime(currentRegime)}`);

    // Check if regime change warrants emergency rebalance
    if (shouldTriggerEmergencyRebalance(previousRegime, currentRegime)) {
      console.log(
        "REGIME SHIFT: Emergency rebalance triggered — " +
        `deployment ${previousRegime?.deploymentPct ?? "?"}% → ${currentRegime.deploymentPct}%`
      );
      return true; // Signal to trigger immediate rebalance
    }

    return false;
  } catch (err) {
    console.error("Signal detection error:", err);
    return false;
  }
}

async function runImbalanceScan(): Promise<void> {
  console.log("\n--- AMM Imbalance Scan ---");
  try {
    const allImbalances = await fetchMarketImbalances();
    latestImbalances = rankByImbalance(allImbalances);

    console.log(
      `Scanned ${allImbalances.length} markets -> ${latestImbalances.length} with tradeable signals`
    );

    latestImbalances.slice(0, 5).forEach((m, i) => {
      const dir = getTradeDirection(m);
      console.log(
        `  ${i + 1}. ${m.market}: signal=${m.signal} (${m.signalStrength.toFixed(0)}%) | ` +
          `premium=${m.premiumPct > 0 ? "+" : ""}${m.premiumPct.toFixed(4)}% | ` +
          `OI imbalance=${m.oiImbalancePct > 0 ? "+" : ""}${m.oiImbalancePct.toFixed(1)}% | ` +
          `funding=${m.annualizedFundingPct.toFixed(1)}% APY | ` +
          `-> ${dir.direction.toUpperCase()} (${dir.reason})`
      );
    });
  } catch (err) {
    console.error("Imbalance scan error:", err);
  }
}

async function runEmergencyChecks(driftClient: DriftClient): Promise<boolean> {
  // Health ratio check
  const health = computeHealthState(driftClient);
  if (health.action !== "none") {
    console.log(
      `HEALTH ${health.status.toUpperCase()}: ratio=${health.healthRatio.toFixed(3)} collateral=$${health.totalCollateral.toFixed(2)} pnl=$${health.unrealizedPnl.toFixed(2)}`
    );

    if (health.action === "close_all") {
      console.log("EMERGENCY: Closing all positions — health critical");
      for (let i = activePositions.length - 1; i >= 0; i--) {
        await closeBasisPosition(driftClient, activePositions[i].marketIndex);
        activePositions.splice(i, 1);
      }
      return true;
    }

    if (health.action === "reduce") {
      console.log("WARNING: Reducing positions — health declining");
      if (activePositions.length > 0) {
        const largest = activePositions.reduce((a, b) =>
          a.sizeUsd > b.sizeUsd ? a : b
        );
        await closeBasisPosition(driftClient, largest.marketIndex);
        const idx = activePositions.indexOf(largest);
        activePositions.splice(idx, 1);
      }
    }
  }

  // Drawdown check
  const equity =
    driftClient.getUser().getTotalCollateral().toNumber() / 1e6;
  if (equity < 0) {
    console.error(`CRITICAL: Negative equity detected ($${equity.toFixed(2)}) — closing all positions`);
    for (let i = activePositions.length - 1; i >= 0; i--) {
      await closeBasisPosition(driftClient, activePositions[i].marketIndex);
      activePositions.splice(i, 1);
    }
    return true;
  }
  if (equity > peakEquity) peakEquity = equity;

  const drawdown = computeDrawdown(equity, peakEquity);
  if (drawdown.action !== "none") {
    console.log(
      `DRAWDOWN ${drawdown.drawdownPct.toFixed(2)}%: equity=$${equity.toFixed(2)} peak=$${peakEquity.toFixed(2)}`
    );

    if (drawdown.action === "close_all") {
      console.log("EMERGENCY: Closing all positions — severe drawdown");
      for (let i = activePositions.length - 1; i >= 0; i--) {
        await closeBasisPosition(driftClient, activePositions[i].marketIndex);
        activePositions.splice(i, 1);
      }
      return true;
    }

    if (drawdown.action === "reduce") {
      console.log("WARNING: Reducing positions — drawdown limit");
      if (activePositions.length > 0) {
        const worst = activePositions[activePositions.length - 1];
        await closeBasisPosition(driftClient, worst.marketIndex);
        activePositions.splice(activePositions.length - 1, 1);
      }
    }
  }

  // YOGI-SPECIFIC: Signal-driven emergency
  // If signals are CRITICAL and we have positions, force reduce
  if (currentSignals.severity >= 3 && activePositions.length > 0) {
    console.log("SIGNAL CRITICAL: Reducing positions — anomaly detected");
    const largest = activePositions.reduce((a, b) =>
      a.sizeUsd > b.sizeUsd ? a : b
    );
    await closeBasisPosition(driftClient, largest.marketIndex);
    const idx = activePositions.indexOf(largest);
    activePositions.splice(idx, 1);
  }

  return false;
}

async function runFundingScan(driftClient: DriftClient): Promise<void> {
  console.log("\n--- Funding Rate Scan ---");
  const rates = await fetchAllFundingRates();
  const ranked = rankMarketsByFunding(
    rates,
    STRATEGY_CONFIG.minAnnualizedFundingBps
  );

  const costFiltered = ranked.filter((m) => {
    const passes = passesCostGate(m.annualizedPct * 100);
    if (!passes && m.annualizedPct > 5) {
      console.log(
        `  Filtered: ${m.market} (${m.annualizedPct.toFixed(2)}% APY — below cost threshold)`
      );
    }
    return passes;
  });

  console.log(
    `Markets: ${rates.length} total -> ${ranked.length} positive funding -> ${costFiltered.length} cost-viable`
  );
  costFiltered.slice(0, 5).forEach((m, i) => {
    const econ = evaluateTradeEconomics(m.annualizedPct * 100);
    console.log(
      `  ${i + 1}. ${m.market}: ${m.annualizedPct.toFixed(2)}% APY (net: ${econ.netProfitBps.toFixed(1)} bps/day, break-even: ${econ.breakEvenHours.toFixed(0)}h)`
    );
  });
}

async function runRebalance(driftClient: DriftClient): Promise<void> {
  console.log("\n--- Rebalance Cycle ---");

  // YOGI-SPECIFIC: Use regime engine for leverage and deployment
  const effectiveLeverage = currentRegime
    ? currentRegime.maxLeverage
    : currentLeverage?.targetLeverage ?? 0;

  const deploymentPct = currentRegime
    ? currentRegime.deploymentPct
    : 100;

  if (effectiveLeverage === 0 || deploymentPct === 0) {
    console.log(
      `Regime: ${currentRegime?.rebalanceMode ?? "unknown"} — closing all positions ` +
      `(leverage=${effectiveLeverage}x, deployment=${deploymentPct}%)`
    );
    for (let i = activePositions.length - 1; i >= 0; i--) {
      await closeBasisPosition(driftClient, activePositions[i].marketIndex);
      activePositions.splice(i, 1);
    }
    return;
  }

  // 1. Check existing positions for exit signals
  const rates = await fetchAllFundingRates();
  const rateMap = new Map(rates.map((r) => [r.marketIndex, r]));

  for (let i = activePositions.length - 1; i >= 0; i--) {
    const pos = activePositions[i];
    const currentRate = rateMap.get(pos.marketIndex);
    if (!currentRate) continue;

    const { exit, reason } = shouldExitPosition(pos, currentRate.rate24h);
    if (exit) {
      console.log(`Exiting ${pos.marketName}: ${reason}`);
      await closeBasisPosition(driftClient, pos.marketIndex);
      activePositions.splice(i, 1);
    }
  }

  // 2. Compute target allocations with regime-adjusted sizing
  const ranked = rankMarketsByFunding(
    rates,
    STRATEGY_CONFIG.minAnnualizedFundingBps
  ).filter((m) => passesCostGate(m.annualizedPct * 100));

  const user = driftClient.getUser();
  const totalEquity = user.getTotalCollateral().toNumber() / 1e6;

  // YOGI-SPECIFIC: Scale equity by deployment percentage
  const deployableEquity = totalEquity * (deploymentPct / 100);

  console.log(
    `Equity: $${totalEquity.toFixed(2)} | Deployable: $${deployableEquity.toFixed(2)} (${deploymentPct}%) | ` +
    `Leverage: ${effectiveLeverage}x | Mode: ${currentRegime?.rebalanceMode ?? "unknown"}`
  );

  const { lendingTarget, basisTargets } = computeTargetAllocations(
    deployableEquity, // Use deployable equity instead of total
    ranked,
    activePositions
  );

  // Scale basis targets by regime-adjusted leverage
  const scaledTargets = basisTargets.map((t) => ({
    ...t,
    sizeUsd: t.sizeUsd * effectiveLeverage,
  }));

  console.log(`Lending target: $${lendingTarget.toFixed(2)}`);
  console.log(`Basis targets: ${scaledTargets.length} markets`);

  // 3. Open new positions with imbalance-directed entry
  const activeMarkets = new Set(activePositions.map((p) => p.marketIndex));
  const imbalanceMap = new Map(latestImbalances.map((m) => [m.marketIndex, m]));

  for (const target of scaledTargets) {
    if (activeMarkets.has(target.marketIndex)) continue;
    if (target.sizeUsd < 10) continue;

    let direction: "short" | "long" = "short";
    let entryReason = "funding positive -> short";

    if (STRATEGY_CONFIG.useImbalanceSignals) {
      const imbalance = imbalanceMap.get(target.marketIndex);
      if (imbalance) {
        const trade = getTradeDirection(imbalance);
        if (trade.direction === "none") {
          console.log(
            `  Skipping ${target.marketName}: ${trade.reason}`
          );
          continue;
        }
        direction = trade.direction;
        entryReason = trade.reason;
      }
    }

    // YOGI-SPECIFIC: In cautious/defensive mode, require stronger signals
    if (currentRegime?.rebalanceMode === "cautious" || currentRegime?.rebalanceMode === "defensive") {
      const imbalance = imbalanceMap.get(target.marketIndex);
      const minStrength = STRATEGY_CONFIG.cautiousMinSignalStrength;
      if (imbalance && imbalance.signalStrength < minStrength) {
        console.log(
          `  Skipping ${target.marketName}: signal too weak for ${currentRegime.rebalanceMode} mode (${imbalance.signalStrength.toFixed(0)}% < ${minStrength}%)`
        );
        continue;
      }
    }

    try {
      console.log(`  Opening ${target.marketName}: ${entryReason}`);
      await openBasisPosition(
        driftClient,
        target.marketIndex,
        target.sizeUsd,
        direction
      );

      activePositions.push({
        marketIndex: target.marketIndex,
        marketName: target.marketName,
        direction,
        sizeUsd: target.sizeUsd,
        entryFundingRate: rateMap.get(target.marketIndex)?.rate24h ?? 0,
        entryTimestamp: Date.now(),
      });
    } catch (err) {
      console.error(`Failed to open position on ${target.marketName}:`, err);
    }
  }
}

async function main(): Promise<void> {
  console.log("Yogi Keeper Starting...");
  console.log("Strategy: Drift basis trade alpha + intelligent signal detection");
  console.log("Intelligence: OI shift, liquidation cascade, funding vol, spread blow-out");
  console.log("Regime: Vol regime x signal severity -> adaptive deployment + leverage\n");

  const connection = getConnection();
  const managerKeypair = loadKeypair("MANAGER_KEYPAIR_PATH");

  console.log(`Manager: ${managerKeypair.publicKey.toBase58()}`);

  const driftClient = await initDriftClient(connection, managerKeypair);
  console.log("Drift client connected.\n");

  // Initialize all systems
  await updateLeverage();
  await runSignalDetection();
  await runImbalanceScan();
  await runFundingScan(driftClient);

  let lastScan = Date.now();
  let lastRebalance = 0;
  let lastEmergencyCheck = 0;
  let lastLeverageUpdate = Date.now();
  let lastSignalDetection = Date.now();

  while (true) {
    const now = Date.now();

    // Emergency checks (every 30s) — health ratio + drawdown + signal severity
    if (now - lastEmergencyCheck >= STRATEGY_CONFIG.emergencyCheckIntervalMs) {
      try {
        const emergency = await runEmergencyChecks(driftClient);
        if (emergency) {
          console.log("Emergency triggered — pausing rebalance for 5 minutes");
          lastRebalance = now;
        }
      } catch (err) {
        console.error("Emergency check error:", err);
      }
      lastEmergencyCheck = now;
    }

    // YOGI-SPECIFIC: Signal detection (every 5 min)
    if (now - lastSignalDetection >= STRATEGY_CONFIG.signalDetectionIntervalMs) {
      const emergencyRebalance = await runSignalDetection();
      if (emergencyRebalance) {
        // Regime shift detected — trigger immediate rebalance
        try {
          await runRebalance(driftClient);
        } catch (err) {
          console.error("Emergency rebalance error:", err);
        }
        lastRebalance = now;
      }
      lastSignalDetection = now;
    }

    // Leverage + imbalance update (every scan interval)
    if (now - lastLeverageUpdate >= STRATEGY_CONFIG.fundingScanIntervalMs) {
      await updateLeverage();
      await runImbalanceScan();
      lastLeverageUpdate = now;
    }

    // Funding scan
    if (now - lastScan >= STRATEGY_CONFIG.fundingScanIntervalMs) {
      try {
        await runFundingScan(driftClient);
      } catch (err) {
        console.error("Funding scan error:", err);
      }
      lastScan = now;
    }

    // Rebalance (every 4 hours)
    if (now - lastRebalance >= STRATEGY_CONFIG.rebalanceIntervalMs) {
      try {
        await runRebalance(driftClient);
      } catch (err) {
        console.error("Rebalance error:", err);
      }
      lastRebalance = now;
    }

    // Heartbeat
    const equity = driftClient.getUser().getTotalCollateral().toNumber() / 1e6;
    const severityLabels = ["CLEAR", "LOW", "HIGH", "CRITICAL"];
    console.log(
      `[${new Date().toISOString()}] Positions: ${activePositions.length} | ` +
      `Equity: $${equity.toFixed(2)} | ` +
      `Regime: ${currentRegime?.rebalanceMode ?? "?"} (${currentRegime?.deploymentPct ?? "?"}% @ ${currentRegime?.maxLeverage ?? "?"}x) | ` +
      `Signal: ${severityLabels[currentSignals.severity]} | ` +
      `Next rebalance: ${Math.round((STRATEGY_CONFIG.rebalanceIntervalMs - (now - lastRebalance)) / 60000)}min`
    );

    await sleep(30_000);
  }
}

main().catch((err) => {
  console.error("Yogi keeper fatal error:", err);
  process.exit(1);
});
