import {
  decideEmergencyAction,
  shouldSkipOrphanedSpot,
} from "../keeper/emergency-decisions";

function assert(condition: boolean, msg: string) {
  if (!condition) {
    console.error(`  FAIL: ${msg}`);
    process.exitCode = 1;
  } else {
    console.log(`  PASS: ${msg}`);
  }
}

const defaults = {
  healthAction: "none" as const,
  equity: 1000,
  peakEquity: 1000,
  drawdownAction: "none" as const,
  signalSeverity: 0,
  hasActivePositions: false,
};

// ============================================================
console.log("=== Emergency Decision Tests ===\n");

// --- Health-based decisions ---
console.log("Health close_all:");
{
  const action = decideEmergencyAction({
    ...defaults,
    healthAction: "close_all",
  });
  assert(action.kind === "close_all", "health critical triggers close_all");
  assert(
    action.kind === "close_all" && action.resetPeak === false,
    "health close_all does NOT reset peak"
  );
}

{
  const action = decideEmergencyAction({
    ...defaults,
    healthAction: "close_all",
    drawdownAction: "close_all",
    signalSeverity: 5,
  });
  assert(
    action.kind === "close_all" && action.resetPeak === false,
    "health close_all takes priority over drawdown close_all (resetPeak=false)"
  );
}

console.log("\nHealth reduce:");
{
  const action = decideEmergencyAction({
    ...defaults,
    healthAction: "reduce",
    hasActivePositions: true,
  });
  assert(action.kind === "reduce_health", "health reduce returns reduce_health");
}

{
  const action = decideEmergencyAction({
    ...defaults,
    healthAction: "reduce",
    hasActivePositions: false,
  });
  assert(
    action.kind === "reduce_health",
    "health reduce returns reduce_health even with no active positions (executor handles empty list)"
  );
}

// --- Negative equity ---
console.log("\nNegative equity:");
{
  const action = decideEmergencyAction({
    ...defaults,
    equity: -50,
  });
  assert(action.kind === "close_all", "negative equity triggers close_all");
}

{
  const action = decideEmergencyAction({
    ...defaults,
    equity: 0,
  });
  assert(action.kind === "none", "zero equity does NOT trigger close_all");
}

// --- Drawdown decisions ---
console.log("\nDrawdown close_all:");
{
  const action = decideEmergencyAction({
    ...defaults,
    drawdownAction: "close_all",
  });
  assert(action.kind === "close_all", "severe drawdown triggers close_all");
  assert(
    action.kind === "close_all" && action.resetPeak === true,
    "drawdown close_all resets peak"
  );
}

console.log("\nDrawdown reduce:");
{
  const action = decideEmergencyAction({
    ...defaults,
    drawdownAction: "reduce",
    hasActivePositions: true,
  });
  assert(action.kind === "reduce_drawdown", "moderate drawdown returns reduce_drawdown");
}

// --- BUG A REGRESSION: drawdown close_all must not depend on position lists ---
console.log("\n** Bug A regression (drawdown close_all with only DN positions):");
{
  // This was the exact bug: DN positions existed but activePositions was empty.
  // The old code only closed activePositions, leaving DN stuck in emergency loop.
  const action = decideEmergencyAction({
    ...defaults,
    drawdownAction: "close_all",
    hasActivePositions: false,
  });
  assert(
    action.kind === "close_all",
    "drawdown close_all fires even when hasActivePositions=false (DN-only case)"
  );
  assert(
    action.kind === "close_all" && action.resetPeak === true,
    "drawdown close_all resets peak in DN-only case"
  );
}

// --- Signal severity ---
console.log("\nSignal severity:");
{
  const action = decideEmergencyAction({
    ...defaults,
    signalSeverity: 3,
    hasActivePositions: true,
  });
  assert(action.kind === "reduce_signal", "severity 3 with positions triggers reduce_signal");
}

{
  const action = decideEmergencyAction({
    ...defaults,
    signalSeverity: 3,
    hasActivePositions: false,
  });
  assert(action.kind === "none", "severity 3 without positions returns none");
}

{
  const action = decideEmergencyAction({
    ...defaults,
    signalSeverity: 2,
    hasActivePositions: true,
  });
  assert(action.kind === "none", "severity 2 returns none (below threshold)");
}

// --- Priority ordering ---
console.log("\nPriority ordering:");
{
  const action = decideEmergencyAction({
    ...defaults,
    equity: -100,
    drawdownAction: "reduce",
    signalSeverity: 5,
    hasActivePositions: true,
  });
  assert(action.kind === "close_all", "negative equity beats drawdown reduce and signal");
}

{
  const action = decideEmergencyAction({
    ...defaults,
    healthAction: "reduce",
    drawdownAction: "close_all",
  });
  assert(action.kind === "reduce_health", "health reduce beats drawdown close_all");
}

// --- All clear ---
console.log("\nAll clear:");
{
  const action = decideEmergencyAction(defaults);
  assert(action.kind === "none", "no emergency returns none");
}

// ============================================================
console.log("\n=== Orphaned Spot Decision Tests ===\n");

// Normal sell
console.log("Normal sell:");
{
  const result = shouldSkipOrphanedSpot({
    spotSizeCoins: 1.5,
    spotPrecision: 1e9,
    minOrderSize: 100_000_000,
  });
  assert(!result.skip, "1.5 SOL is above min order size");
  assert(result.baseAmount === 1_500_000_000, "base amount is correct");
}

// ** Bug B regression: dust below min order size
console.log("\n** Bug B regression (dust below min order size):");
{
  // Exact scenario: 0.0999 SOL (99,900,000 base) vs 0.1 SOL minimum (100,000,000)
  const result = shouldSkipOrphanedSpot({
    spotSizeCoins: 0.0999,
    spotPrecision: 1e9,
    minOrderSize: 100_000_000,
  });
  assert(result.skip, "0.0999 SOL skipped (below 0.1 SOL minimum)");
  assert(result.baseAmount === 99_900_000, "base amount matches the failing tx");
}

// Boundary: exactly at min order size
console.log("\nBoundary — exactly at min:");
{
  const result = shouldSkipOrphanedSpot({
    spotSizeCoins: 0.1,
    spotPrecision: 1e9,
    minOrderSize: 100_000_000,
  });
  assert(!result.skip, "exactly 0.1 SOL is NOT skipped");
  assert(result.baseAmount === 100_000_000, "base amount equals min order size");
}

// Boundary: one unit below
console.log("\nBoundary — one unit below min:");
{
  const result = shouldSkipOrphanedSpot({
    spotSizeCoins: 0.099999999,
    spotPrecision: 1e9,
    minOrderSize: 100_000_000,
  });
  assert(result.skip, "one base unit below min is skipped");
  assert(result.baseAmount === 99_999_999, "base amount is min - 1");
}

// Zero min order size (permissive market)
console.log("\nZero min order size:");
{
  const result = shouldSkipOrphanedSpot({
    spotSizeCoins: 0.000001,
    spotPrecision: 1e9,
    minOrderSize: 0,
  });
  assert(!result.skip, "any positive amount passes when min is 0");
}

console.log("\n=== Done ===");
if (process.exitCode === 1) {
  console.error("\nSOME TESTS FAILED");
} else {
  console.log("\nAll tests passed.");
}
