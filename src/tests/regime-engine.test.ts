import {
  computeDriftRegime,
  shouldTriggerEmergencyRebalance,
  DriftRegime,
} from "../keeper/regime-engine";
import {
  SIGNAL_NONE,
  SIGNAL_LOW,
  SIGNAL_HIGH,
  SIGNAL_CRITICAL,
} from "../keeper/drift-signal-detector";

function assert(condition: boolean, msg: string) {
  if (!condition) {
    console.error(`  FAIL: ${msg}`);
    process.exitCode = 1;
  } else {
    console.log(`  PASS: ${msg}`);
  }
}

console.log("=== Regime Engine Tests ===\n");

// Test 1: Base case — no signals, baseline behavior (no signals)
console.log("Base case (no signals):");
const veryLowClear = computeDriftRegime("veryLow", SIGNAL_NONE);
assert(veryLowClear.deploymentPct === 100, `veryLow + NONE → 100% (got ${veryLowClear.deploymentPct}%)`);
assert(veryLowClear.maxLeverage === 2.0, `veryLow + NONE → 2.0x (got ${veryLowClear.maxLeverage}x)`);
assert(veryLowClear.rebalanceMode === "aggressive", `Should be aggressive (got ${veryLowClear.rebalanceMode})`);

const normalClear = computeDriftRegime("normal", SIGNAL_NONE);
assert(normalClear.deploymentPct === 70, `normal + NONE → 70% (got ${normalClear.deploymentPct}%)`);
assert(normalClear.maxLeverage === 1.0, `normal + NONE → 1.0x (got ${normalClear.maxLeverage}x)`);

const extremeClear = computeDriftRegime("extreme", SIGNAL_NONE);
assert(extremeClear.deploymentPct === 0, `extreme + NONE → 0% (got ${extremeClear.deploymentPct}%)`);
assert(extremeClear.maxLeverage === 0, `extreme + NONE → 0x (got ${extremeClear.maxLeverage}x)`);

// Test 2: Signal severity reduces deployment
console.log("\nSignal severity reduces deployment:");
const lowSignal = computeDriftRegime("veryLow", SIGNAL_LOW);
assert(lowSignal.deploymentPct === 80, `veryLow + LOW → 80% (got ${lowSignal.deploymentPct}%)`);
assert(lowSignal.maxLeverage === 1.5, `veryLow + LOW → 1.5x (got ${lowSignal.maxLeverage}x)`);

const highSignal = computeDriftRegime("veryLow", SIGNAL_HIGH);
assert(highSignal.deploymentPct === 50, `veryLow + HIGH → 50% (got ${highSignal.deploymentPct}%)`);
assert(highSignal.maxLeverage === 1.0, `veryLow + HIGH → 1.0x (got ${highSignal.maxLeverage}x)`);

const criticalSignal = computeDriftRegime("veryLow", SIGNAL_CRITICAL);
assert(criticalSignal.deploymentPct === 25, `veryLow + CRITICAL → 25% (got ${criticalSignal.deploymentPct}%)`);
assert(criticalSignal.maxLeverage === 0.5, `veryLow + CRITICAL → 0.5x (got ${criticalSignal.maxLeverage}x)`);

// Test 3: Yogi's key advantage — low vol + critical signal
// A vol-only strategy would be fully deployed at 2x. Yogi pulls back to 25% at 0.5x.
console.log("\nYogi advantage (low vol + critical signal):");
const yogiAdvantage = computeDriftRegime("veryLow", SIGNAL_CRITICAL);
const baselineEquivalent = computeDriftRegime("veryLow", SIGNAL_NONE);
assert(
  yogiAdvantage.deploymentPct < baselineEquivalent.deploymentPct,
  `Yogi deploys less with signals (${yogiAdvantage.deploymentPct}% vs baseline ${baselineEquivalent.deploymentPct}%)`
);
assert(
  yogiAdvantage.maxLeverage < baselineEquivalent.maxLeverage,
  `Yogi uses less leverage with signals (${yogiAdvantage.maxLeverage}x vs baseline ${baselineEquivalent.maxLeverage}x)`
);

// Test 4: Compounding effect — high vol + high signal
console.log("\nCompounding (high vol + high signal):");
const compound = computeDriftRegime("high", SIGNAL_HIGH);
assert(compound.deploymentPct === 20, `high + HIGH → 20% (got ${compound.deploymentPct}%)`);
assert(compound.maxLeverage === 0.2, `high + HIGH → 0.2x (got ${compound.maxLeverage}x)`);
assert(compound.rebalanceMode === "cautious", `Should be cautious (got ${compound.rebalanceMode})`);

// Test 5: Defensive mode
console.log("\nDefensive mode:");
const defensive = computeDriftRegime("high", SIGNAL_CRITICAL);
assert(defensive.deploymentPct === 10, `high + CRITICAL → 10% (got ${defensive.deploymentPct}%)`);
assert(defensive.rebalanceMode === "defensive", `Should be defensive (got ${defensive.rebalanceMode})`);

// Test 6: Emergency rebalance triggers
console.log("\nEmergency rebalance triggers:");
const before: DriftRegime = computeDriftRegime("veryLow", SIGNAL_NONE);

// Large deployment drop (100% → 50%)
const after1 = computeDriftRegime("veryLow", SIGNAL_HIGH);
assert(
  shouldTriggerEmergencyRebalance(before, after1),
  `100% → 50% should trigger emergency (drop = ${before.deploymentPct - after1.deploymentPct}%)`
);

// NONE → CRITICAL severity jump
const after2 = computeDriftRegime("veryLow", SIGNAL_CRITICAL);
assert(
  shouldTriggerEmergencyRebalance(before, after2),
  "NONE → CRITICAL should trigger emergency"
);

// Small change — no trigger
const after3 = computeDriftRegime("veryLow", SIGNAL_LOW);
assert(
  !shouldTriggerEmergencyRebalance(before, after3),
  "100% → 80% should NOT trigger emergency (only 20% drop)"
);

// No previous regime
assert(
  !shouldTriggerEmergencyRebalance(undefined, after1),
  "No previous regime should NOT trigger emergency"
);

// Test 7: Extreme vol always shuts down regardless of signals
console.log("\nExtreme vol override:");
for (const severity of [SIGNAL_NONE, SIGNAL_LOW, SIGNAL_HIGH, SIGNAL_CRITICAL] as const) {
  const r = computeDriftRegime("extreme", severity);
  assert(r.deploymentPct === 0, `extreme + severity ${severity} → 0% (got ${r.deploymentPct}%)`);
  assert(r.maxLeverage === 0, `extreme + severity ${severity} → 0x (got ${r.maxLeverage}x)`);
}

console.log("\n=== Regime Engine Tests Complete ===");
