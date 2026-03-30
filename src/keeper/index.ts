import { writeFileSync } from "fs";
import { join } from "path";
import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import {
  DriftClient,
  Wallet,
  getUserAccountPublicKeySync,
} from "@drift-labs/sdk";
import BN from "bn.js";
import { getConnection, loadKeypair, sleep } from "../utils/helpers";
import { STRATEGY_CONFIG } from "../config/vault";
import { DRIFT_PROGRAM_ID } from "../config/constants";
import {
  fetchAllFundingRates,
  rankMarketsByFunding,
  rankMarketsByNegativeFunding,
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
import {
  fetchCrossVenueFunding,
  getCrossVenueAdjustment,
  getOIAdjustment,
  formatCrossVenue,
  VenueFunding,
} from "./cross-venue-detector";
import {
  DeltaNeutralPosition,
  DN_MARKET_MAP,
  openDeltaNeutral,
  closeDeltaNeutral,
  checkDeltaDrift,
  formatDnPosition,
  loadExistingDnPositions,
  computeDynamicTilt,
  ensureAllDustBuffers,
  getDelta,
  getDeltaPct,
  getNotionalUsd,
} from "./delta-neutral";

// --- Global State ---
const activePositions: BasisPosition[] = [];
const dnPositions: DeltaNeutralPosition[] = [];
let peakEquity = 0;
let currentLeverage: LeverageState | undefined;
let latestImbalances: MarketImbalance[] = [];
let latestCrossVenue: VenueFunding[] = [];
let currentSignals: DriftSignalState = {
  severity: SIGNAL_NONE,
  events: [],
  timestamp: Date.now(),
  marketSnapshots: [],
};
let currentRegime: DriftRegime | undefined;

// Vault's Drift user authority (vaultStrategyAuth PDA)
const VAULT_STRATEGY_AUTH = new PublicKey(
  "4dvzQ6Hux3YFJuWUcdqgYRddJFa8yo5EDzL7a49PyxLB"
);

async function initDriftClient(
  connection: Connection,
  keypair: Keypair
): Promise<DriftClient> {
  const wallet = new Wallet(keypair);

  // Manager is the delegate on the vault's Drift user.
  // We use authoritySubAccountMap to load the vault's Drift user,
  // allowing the keeper to trade on behalf of the vault.
  const driftClient = new DriftClient({
    connection,
    wallet,
    programID: DRIFT_PROGRAM_ID,
    activeSubAccountId: 0,
    authoritySubAccountMap: new Map([
      [VAULT_STRATEGY_AUTH.toBase58(), [0]],
    ]),
    accountSubscription: {
      type: "websocket",
    },
    skipLoadUsers: false,
    // Load all perp and spot markets so we can place orders on any market
    perpMarketIndexes: [0, 1, 2, 3, 7, 9, 22], // SOL, BTC, ETH, APT, DOGE, SUI, AVAX
    spotMarketIndexes: [0, 1, 2, 3, 5], // USDC, SOL, BTC, ETH, USDT
  });

  console.log("Subscribing to Drift...");
  await driftClient.subscribe();

  // Switch active user to vault's Drift user
  const vaultUserKey = getUserAccountPublicKeySync(
    DRIFT_PROGRAM_ID,
    VAULT_STRATEGY_AUTH,
    0
  );
  console.log(`Vault Drift user: ${vaultUserKey.toBase58()}`);

  try {
    await driftClient.addUser(0, VAULT_STRATEGY_AUTH);
    await driftClient.switchActiveUser(0, VAULT_STRATEGY_AUTH);
    const user = driftClient.getUser();
    const equity = user.getTotalCollateral().toNumber() / 1e6;
    console.log(`Active user: ${user.getUserAccountPublicKey().toBase58()}`);
    console.log(`Equity: $${equity.toFixed(2)}`);
  } catch (e) {
    console.error("User setup failed:", e);
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

    // Cross-venue funding comparison (5th signal dimension)
    try {
      const crossVenue = await fetchCrossVenueFunding();
      console.log(formatCrossVenue(crossVenue));
      // Store for rebalance use
      latestCrossVenue = crossVenue;
    } catch (err) {
      console.error("Cross-venue fetch error:", err);
    }

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
      // Close DN positions first
      for (const pos of [...dnPositions]) {
        await closeDeltaNeutral(driftClient, pos);
      }
      dnPositions.length = 0;
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
    for (const pos of [...dnPositions]) {
      await closeDeltaNeutral(driftClient, pos);
    }
    dnPositions.length = 0;
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

  // Also show negative funding markets (LONG candidates)
  const negativeRanked = rankMarketsByNegativeFunding(
    rates,
    STRATEGY_CONFIG.minAnnualizedFundingBps
  );
  if (negativeRanked.length > 0) {
    console.log(`  --- Negative funding (LONG candidates): ${negativeRanked.length} markets ---`);
    negativeRanked.slice(0, 5).forEach((m, i) => {
      console.log(
        `  ${i + 1}. ${m.market}: ${m.annualizedPct.toFixed(2)}% APY -> LONG collects ${Math.abs(m.annualizedPct).toFixed(2)}%`
      );
    });
  }
}

/**
 * DN Rebalance: manage delta-neutral positions (spot buy + perp short).
 * This is Yogi's primary mode — funding-only profit with dynamic tilt.
 */
async function runDnRebalance(driftClient: DriftClient): Promise<void> {
  console.log("\n--- Rebalance Cycle (DELTA-NEUTRAL) ---");

  const effectiveLeverage = currentRegime
    ? currentRegime.maxLeverage
    : currentLeverage?.targetLeverage ?? 0;
  const deploymentPct = currentRegime?.deploymentPct ?? 100;

  // Close all if regime says zero
  if (effectiveLeverage === 0 || deploymentPct === 0) {
    const mode = currentRegime?.rebalanceMode ?? "unknown";
    console.log(`Regime: ${mode} — closing all DN positions`);
    for (const pos of [...dnPositions]) {
      await closeDeltaNeutral(driftClient, pos);
    }
    dnPositions.length = 0;
    // Also close any directional leftovers
    for (let i = activePositions.length - 1; i >= 0; i--) {
      await closeBasisPosition(driftClient, activePositions[i].marketIndex);
      activePositions.splice(i, 1);
    }
    return;
  }

  const user = driftClient.getUser();
  const totalEquity = user.getTotalCollateral().toNumber() / 1e6;
  const deployable = totalEquity * (deploymentPct / 100);
  const mode = currentRegime?.rebalanceMode ?? "unknown";

  console.log(
    `Equity: $${totalEquity.toFixed(2)} | Deployable: $${deployable.toFixed(2)} (${deploymentPct}%) | ` +
    `Leverage: ${effectiveLeverage}x | Mode: ${mode}`
  );

  // 1. Check existing DN positions for exit signals (funding flipped)
  const rates = await fetchAllFundingRates();
  const rateMap = new Map(rates.map((r) => [r.market, r]));
  const dnMinApy = STRATEGY_CONFIG.dnMinFundingApy ?? 5.0;

  for (let i = dnPositions.length - 1; i >= 0; i--) {
    const pos = dnPositions[i];
    const marketName = `${pos.coin}-PERP`;
    const rate = rateMap.get(marketName);
    if (rate && rate.annualizedPct < dnMinApy) {
      console.log(
        `Closing DN ${pos.coin}: funding ${rate.annualizedPct.toFixed(1)}% below ${dnMinApy}% threshold`
      );
      await closeDeltaNeutral(driftClient, pos);
      dnPositions.splice(i, 1);
    }
  }

  // 2. Check delta drift on remaining positions
  for (const pos of dnPositions) {
    const drift = checkDeltaDrift(pos, driftClient);
    if (drift.drifted) {
      console.log(
        `Delta drift on ${pos.coin}: ${drift.deltaPct.toFixed(1)}% — needs rebalancing`
      );
    }
  }

  // 3. Log existing positions
  for (const pos of dnPositions) {
    const oracleData = driftClient.getOracleDataForPerpMarket(pos.perpMarketIndex);
    const price = oracleData.price.toNumber() / 1e6;
    console.log(`  Holding: ${formatDnPosition(pos, price)}`);
  }

  // 4. Find markets eligible for new DN positions
  const activeDnCoins = new Set(dnPositions.map((p) => p.coin));
  const eligible = STRATEGY_CONFIG.dnEligibleMarkets ?? ["SOL-PERP", "BTC-PERP", "ETH-PERP"];
  const maxDnPositions = STRATEGY_CONFIG.maxMarketsSimultaneous ?? 3;

  const ranked = rankMarketsByFunding(rates, STRATEGY_CONFIG.minAnnualizedFundingBps)
    .filter((m) => {
      if (!eligible.includes(m.market)) return false;
      if (!DN_MARKET_MAP[m.market]) return false;
      if (activeDnCoins.has(m.market.replace("-PERP", ""))) return false;
      if (m.annualizedPct < dnMinApy) return false;
      return passesCostGate(m.annualizedPct * 100);
    });

  const slotsAvailable = maxDnPositions - dnPositions.length;
  if (slotsAvailable <= 0 || ranked.length === 0) {
    if (ranked.length === 0 && dnPositions.length === 0) {
      console.log("No DN-eligible markets above funding threshold");
    }
    return;
  }

  // 5. Calculate capital per new position
  const capitalInUse = dnPositions.reduce(
    (sum, p) => sum + getNotionalUsd(p) / 0.70,
    0
  );
  const remainingCapital = Math.max(0, deployable - capitalInUse);

  const newMarkets = ranked.slice(0, slotsAvailable);
  if (remainingCapital < 10) {
    console.log(`Insufficient remaining capital: $${remainingCapital.toFixed(2)}`);
    return;
  }

  const capitalPerPosition = remainingCapital / newMarkets.length;

  // 6. Open new DN positions with dynamic tilt
  const volRegime = currentLeverage?.regime ?? "normal";
  const signalSeverity = currentSignals.severity;

  for (const marketData of newMarkets) {
    if (capitalPerPosition < 5) {
      console.log(`Skipping ${marketData.market}: insufficient capital ($${capitalPerPosition.toFixed(2)})`);
      continue;
    }

    const dynamicTilt = computeDynamicTilt(
      signalSeverity,
      volRegime,
      marketData.rate24h,
    );

    console.log(
      `Opening DN: ${marketData.market} at ${marketData.annualizedPct.toFixed(1)}% APY | ` +
      `capital: $${capitalPerPosition.toFixed(2)} | tilt: ${(dynamicTilt * 100).toFixed(0)}%`
    );

    const pos = await openDeltaNeutral(
      driftClient,
      marketData.market,
      capitalPerPosition,
      dynamicTilt,
    );

    if (pos) {
      pos.entryFundingRate = marketData.rate24h;
      dnPositions.push(pos);
    }
  }
}

async function runRebalance(driftClient: DriftClient): Promise<void> {
  // Delta-neutral mode
  if (STRATEGY_CONFIG.deltaNeutralMode) {
    await runDnRebalance(driftClient);
    return;
  }

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
    if (target.sizeUsd < 1) continue; // Min $1 position (Drift minimum is ~$1)

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

    // Cross-venue funding + OI adjustment
    const crossVenueMap = new Map(latestCrossVenue.map((v) => [v.market, v]));
    const cv = crossVenueMap.get(target.marketName);
    if (cv) {
      const adj = getCrossVenueAdjustment(cv);
      if (Math.abs(adj.adjustment) > 0) {
        entryReason += ` | XV: ${adj.reason}`;
      }
      const oiAdj = getOIAdjustment(cv);
      if (Math.abs(oiAdj.adjustment) > 0) {
        entryReason += ` | OI: ${oiAdj.reason}`;
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

  // --- BIDIRECTIONAL: Open LONG positions on markets with deeply negative funding ---
  const negativeRanked = rankMarketsByNegativeFunding(
    rates,
    STRATEGY_CONFIG.minAnnualizedFundingBps
  ).filter((m) => passesCostGate(Math.abs(m.annualizedPct) * 100));

  const activeMarketsAfterShorts = new Set(activePositions.map((p) => p.marketIndex));
  const maxTotalPositions = STRATEGY_CONFIG.maxMarketsSimultaneous * 2; // Allow shorts + longs

  for (const longMarket of negativeRanked) {
    if (activePositions.length >= maxTotalPositions) break;
    if (activeMarketsAfterShorts.has(longMarket.marketIndex)) continue;

    // Calculate remaining capital for longs
    const usedCapital = activePositions.reduce((s, p) => s + p.sizeUsd, 0);
    const remainingBasis = Math.max(0, (deployableEquity * 0.70) - usedCapital);
    if (remainingBasis < 1) break;

    const longSizeUsd = Math.min(
      remainingBasis / Math.max(1, negativeRanked.length - negativeRanked.indexOf(longMarket)),
      deployableEquity * (STRATEGY_CONFIG.maxPositionPctPerMarket / 100)
    ) * effectiveLeverage;

    if (longSizeUsd < 1) continue;

    try {
      const entryReason = `funding ${longMarket.annualizedPct.toFixed(1)}% -> LONG (collecting negative funding)`;
      console.log(`  Opening LONG ${longMarket.market}: ${entryReason} | $${longSizeUsd.toFixed(2)}`);
      await openBasisPosition(
        driftClient,
        longMarket.marketIndex,
        longSizeUsd,
        "long"
      );

      activePositions.push({
        marketIndex: longMarket.marketIndex,
        marketName: longMarket.market,
        direction: "long",
        sizeUsd: longSizeUsd,
        entryFundingRate: longMarket.rate24h,
        entryTimestamp: Date.now(),
      });
    } catch (err) {
      console.error(`Failed to open LONG on ${longMarket.market}:`, err);
    }
  }
}

async function main(): Promise<void> {
  console.log("Yogi Keeper Starting...");
  console.log(`Strategy: ${STRATEGY_CONFIG.deltaNeutralMode ? "Dynamic Tilted Delta-Neutral" : "Directional basis trade"} + intelligent signal detection`);
  console.log("Intelligence: OI shift, liquidation cascade, funding vol, spread blow-out, cross-venue");
  console.log("Regime: Vol regime x signal severity -> adaptive deployment + leverage");
  if (STRATEGY_CONFIG.deltaNeutralMode) {
    console.log(`DN Mode: spot buy + perp short | tilt 0-${((STRATEGY_CONFIG.dnTiltPct ?? 0.10) * 100).toFixed(0)}% (dynamic)\n`);
  } else {
    console.log("");
  }

  const connection = getConnection();
  const managerKeypair = loadKeypair("MANAGER_KEYPAIR_PATH");

  console.log(`Manager: ${managerKeypair.publicKey.toBase58()}`);

  const driftClient = await initDriftClient(connection, managerKeypair);
  console.log("Drift client connected.\n");

  // Cancel any stale open orders from previous runs
  try {
    const openOrders = driftClient.getUser().getOpenOrders();
    if (openOrders.length > 0) {
      console.log(`Cancelling ${openOrders.length} stale open orders...`);
      await driftClient.cancelOrders();
      console.log("Orders cancelled.");
    }
  } catch (e) {
    console.error("Failed to cancel stale orders:", e);
  }

  // Load existing on-chain positions to prevent duplicate stacking after restart
  try {
    console.log("--- Loading Existing On-Chain Positions ---");

    if (STRATEGY_CONFIG.deltaNeutralMode) {
      // DN mode: reconstruct paired spot+perp positions
      const restored = await loadExistingDnPositions(driftClient);
      dnPositions.push(...restored);

      // Any perp positions without matching spot = directional leftovers
      const user = driftClient.getUser();
      const perpPositions = user.getActivePerpPositions();
      const dnPerpIndexes = new Set(restored.map((p) => p.perpMarketIndex));

      for (const pos of perpPositions) {
        if (dnPerpIndexes.has(pos.marketIndex)) continue;
        const baseAmount = pos.baseAssetAmount.toNumber() / 1e9;
        if (Math.abs(baseAmount) < 0.0001) continue;

        let resolvedName = `market-${pos.marketIndex}`;
        try {
          const market = driftClient.getPerpMarketAccount(pos.marketIndex);
          if (market) resolvedName = Buffer.from(market.name).toString().trim();
        } catch { /* ignore */ }

        const direction: "short" | "long" = baseAmount < 0 ? "short" : "long";
        const oracle = driftClient.getOracleDataForPerpMarket(pos.marketIndex);
        const price = oracle.price.toNumber() / 1e6;
        const sizeUsd = Math.abs(baseAmount) * price;

        activePositions.push({
          marketIndex: pos.marketIndex,
          marketName: resolvedName,
          direction,
          sizeUsd,
          entryFundingRate: 0,
          entryTimestamp: Date.now(),
        });
        console.log(`  Restored directional: ${resolvedName} ${direction} $${sizeUsd.toFixed(2)}`);
      }

      console.log(`  Loaded: ${dnPositions.length} DN + ${activePositions.length} directional positions.\n`);

      // Transition: close leftover directional positions (switching from directional to DN mode)
      if (activePositions.length > 0) {
        console.log("--- Transitioning: closing directional positions for DN mode ---");
        for (let i = activePositions.length - 1; i >= 0; i--) {
          const pos = activePositions[i];
          console.log(`  Closing directional ${pos.marketName} ${pos.direction} $${pos.sizeUsd.toFixed(2)}`);
          try {
            await closeBasisPosition(driftClient, pos.marketIndex);
          } catch (err) {
            console.error(`  Failed to close ${pos.marketName}:`, err);
          }
          activePositions.splice(i, 1);
        }
        console.log("  Directional positions closed. Ready for DN mode.\n");
      }
    } else {
      // Original directional mode
      const user = driftClient.getUser();
      const perpPositions = user.getActivePerpPositions();

      if (perpPositions.length > 0) {
        for (const pos of perpPositions) {
          const baseAmount = pos.baseAssetAmount.toNumber() / 1e9;
          if (Math.abs(baseAmount) < 0.0001) continue;

          const direction: "short" | "long" = baseAmount < 0 ? "short" : "long";
          const marketIndex = pos.marketIndex;

          let resolvedName = `market-${marketIndex}`;
          try {
            const market = driftClient.getPerpMarketAccount(marketIndex);
            if (market) resolvedName = Buffer.from(market.name).toString().trim();
          } catch { /* ignore */ }

          const oracle = driftClient.getOracleDataForPerpMarket(marketIndex);
          const price = oracle.price.toNumber() / 1e6;
          const sizeUsd = Math.abs(baseAmount) * price;

          activePositions.push({
            marketIndex,
            marketName: resolvedName,
            direction,
            sizeUsd,
            entryFundingRate: 0,
            entryTimestamp: Date.now(),
          });

          console.log(`  Restored: ${resolvedName} ${direction} $${sizeUsd.toFixed(2)} (${Math.abs(baseAmount).toFixed(6)} base)`);
        }
        console.log(`  Loaded ${activePositions.length} existing positions.\n`);
      } else {
        console.log("  No existing positions found.\n");
      }
    }
  } catch (e) {
    console.error("Warning: Failed to load existing positions:", e);
  }

  // Ensure dust buffers exist for all DN-eligible spot markets
  // Prevents InsufficientCollateral errors from dust borrows
  if (STRATEGY_CONFIG.deltaNeutralMode) {
    try {
      await ensureAllDustBuffers(driftClient);
    } catch (e) {
      console.error("Warning: Failed to ensure dust buffers:", e);
    }
  }

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
    const posCount = dnPositions.length + activePositions.length;
    const dnTag = STRATEGY_CONFIG.deltaNeutralMode
      ? ` [DN:${dnPositions.length} DIR:${activePositions.length}` +
        (dnPositions.length > 0 ? ` T:${(dnPositions[0].tiltPct * 100).toFixed(0)}%` : "") +
        `]`
      : "";
    console.log(
      `[${new Date().toISOString()}]${dnTag} Positions: ${posCount} | ` +
      `Equity: $${equity.toFixed(2)} | ` +
      `Regime: ${currentRegime?.rebalanceMode ?? "?"} (${currentRegime?.deploymentPct ?? "?"}% @ ${currentRegime?.maxLeverage ?? "?"}x) | ` +
      `Signal: ${severityLabels[currentSignals.severity]} | ` +
      `Next rebalance: ${Math.round((STRATEGY_CONFIG.rebalanceIntervalMs - (now - lastRebalance)) / 60000)}min`
    );

    // Write metrics JSON for autopilot tweet system
    try {
      const metricsPath = join(process.cwd(), "metrics.json");
      const metrics = {
        timestamp: new Date().toISOString(),
        equity,
        positions: posCount,
        dn_count: dnPositions.length,
        dir_count: activePositions.length,
        tilt_pct: dnPositions.length > 0 ? dnPositions[0].tiltPct : 0,
        regime: currentRegime?.rebalanceMode ?? "unknown",
        deployment_pct: currentRegime?.deploymentPct ?? 0,
        leverage: currentRegime?.maxLeverage ?? 0,
        signal_severity: severityLabels[currentSignals.severity],
        signal_events: currentSignals.events.map(e => e.reason).slice(0, 5),
        peak_equity: peakEquity,
        drawdown_pct: peakEquity > 0 ? ((peakEquity - equity) / peakEquity) * 100 : 0,
        starting_equity: 899,
        days_running: Math.floor((Date.now() - new Date("2026-03-20").getTime()) / 86400000),
        pnl_pct: ((equity - 899) / 899) * 100,
        dn_positions: dnPositions.map(p => ({
          market: p.coin,
          spotSize: p.spotSizeCoins,
          perpSize: p.perpSizeCoins,
          entryFunding: p.entryFundingRate,
          tiltPct: p.tiltPct,
        })),
      };
      writeFileSync(metricsPath, JSON.stringify(metrics, null, 2));
    } catch (metricsErr) {
      // Non-fatal — don't crash keeper for metrics
    }

    await sleep(30_000);
  }
}

main().catch((err) => {
  console.error("Yogi keeper fatal error:", err);
  process.exit(1);
});
