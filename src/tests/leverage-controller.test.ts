import {
  classifyVolRegime,
  computeTargetLeverage,
} from "../keeper/leverage-controller";

function assert(condition: boolean, msg: string) {
  if (!condition) {
    console.error(`  FAIL: ${msg}`);
    process.exitCode = 1;
  } else {
    console.log(`  PASS: ${msg}`);
  }
}

console.log("=== Leverage Controller Tests ===\n");

// Test 1: Regime classification
console.log("Regime classification:");
assert(classifyVolRegime(1500) === "veryLow", "15% vol → veryLow");
assert(classifyVolRegime(2500) === "low", "25% vol → low");
assert(classifyVolRegime(4000) === "normal", "40% vol → normal");
assert(classifyVolRegime(6000) === "high", "60% vol → high");
assert(classifyVolRegime(8000) === "extreme", "80% vol → extreme");

// Test 2: Boundary conditions
console.log("\nBoundary conditions:");
assert(classifyVolRegime(2000) === "low", "20% vol (boundary) → low");
assert(classifyVolRegime(1999) === "veryLow", "19.99% vol → veryLow");
assert(classifyVolRegime(7500) === "extreme", "75% vol (boundary) → extreme");

// Test 3: Leverage scaling
console.log("\nLeverage scaling:");
const veryLow = computeTargetLeverage(1500);
assert(veryLow.targetLeverage === 2.0, `veryLow → 2.0x (got ${veryLow.targetLeverage})`);

const low = computeTargetLeverage(2500);
assert(low.targetLeverage === 1.5, `low → 1.5x (got ${low.targetLeverage})`);

const normal = computeTargetLeverage(4000);
assert(normal.targetLeverage === 1.0, `normal → 1.0x (got ${normal.targetLeverage})`);

const high = computeTargetLeverage(6000);
assert(high.targetLeverage === 0.5, `high → 0.5x (got ${high.targetLeverage})`);

const extreme = computeTargetLeverage(8000);
assert(extreme.targetLeverage === 0, `extreme → 0x (got ${extreme.targetLeverage})`);

// Test 4: Leverage never exceeds max (2x)
console.log("\nMax leverage cap:");
const capped = computeTargetLeverage(500); // Very low vol
assert(capped.targetLeverage <= 2.0, `Leverage capped at 2.0x (got ${capped.targetLeverage})`);

// Test 5: Extreme regime reason
assert(
  extreme.reason.includes("Extreme"),
  `Extreme reason should mention extreme (got: ${extreme.reason})`
);

console.log("\n=== Leverage Controller Tests Complete ===");
