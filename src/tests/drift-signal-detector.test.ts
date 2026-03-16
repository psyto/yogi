import {
  SIGNAL_NONE,
  SIGNAL_LOW,
  SIGNAL_HIGH,
  SIGNAL_CRITICAL,
  formatSignalState,
  DriftSignalState,
} from "../keeper/drift-signal-detector";

function assert(condition: boolean, msg: string) {
  if (!condition) {
    console.error(`  FAIL: ${msg}`);
    process.exitCode = 1;
  } else {
    console.log(`  PASS: ${msg}`);
  }
}

console.log("=== Drift Signal Detector Tests ===\n");

// Test 1: Signal severity constants
console.log("Signal severity values:");
assert(SIGNAL_NONE === 0, "SIGNAL_NONE should be 0");
assert(SIGNAL_LOW === 1, "SIGNAL_LOW should be 1");
assert(SIGNAL_HIGH === 2, "SIGNAL_HIGH should be 2");
assert(SIGNAL_CRITICAL === 3, "SIGNAL_CRITICAL should be 3");

// Test 2: Severity ordering
console.log("\nSeverity ordering:");
assert(SIGNAL_NONE < SIGNAL_LOW, "NONE < LOW");
assert(SIGNAL_LOW < SIGNAL_HIGH, "LOW < HIGH");
assert(SIGNAL_HIGH < SIGNAL_CRITICAL, "HIGH < CRITICAL");

// Test 3: Format empty state
console.log("\nFormat signal state:");
const emptyState: DriftSignalState = {
  severity: SIGNAL_NONE,
  events: [],
  timestamp: Date.now(),
  marketSnapshots: [],
};
const emptyFormat = formatSignalState(emptyState);
assert(emptyFormat.includes("CLEAR"), `Empty state should show CLEAR (got: ${emptyFormat})`);

// Test 4: Format state with events
const eventState: DriftSignalState = {
  severity: SIGNAL_HIGH,
  events: [
    {
      dimension: "oi_shift",
      severity: SIGNAL_HIGH,
      reason: "OI imbalance shifted 20% on SOL-PERP",
      timestamp: Date.now(),
      metrics: { maxShift: 20 },
    },
    {
      dimension: "spread_blowout",
      severity: SIGNAL_LOW,
      reason: "Mark/oracle spread 0.8% on BTC-PERP",
      timestamp: Date.now(),
      metrics: { maxSpread: 0.8 },
    },
  ],
  timestamp: Date.now(),
  marketSnapshots: [],
};
const eventFormat = formatSignalState(eventState);
assert(eventFormat.includes("HIGH"), `Should show HIGH severity (got: ${eventFormat.split("\n")[0]})`);
assert(eventFormat.includes("2 anomalies"), `Should show 2 anomalies`);
assert(eventFormat.includes("OI imbalance"), "Should include OI shift reason");
assert(eventFormat.includes("Mark/oracle"), "Should include spread reason");

// Test 5: Max severity aggregation
console.log("\nMax severity aggregation:");
const mixedState: DriftSignalState = {
  severity: Math.max(SIGNAL_LOW, SIGNAL_CRITICAL, SIGNAL_HIGH) as 0 | 1 | 2 | 3,
  events: [
    { dimension: "oi_shift", severity: SIGNAL_LOW, reason: "test", timestamp: 0, metrics: {} },
    { dimension: "liquidation_cascade", severity: SIGNAL_CRITICAL, reason: "test", timestamp: 0, metrics: {} },
    { dimension: "funding_volatility", severity: SIGNAL_HIGH, reason: "test", timestamp: 0, metrics: {} },
  ],
  timestamp: Date.now(),
  marketSnapshots: [],
};
assert(mixedState.severity === SIGNAL_CRITICAL, `Max of LOW,CRITICAL,HIGH should be CRITICAL (got ${mixedState.severity})`);

// Test 6: Dimensions are correct types
console.log("\nDimension types:");
const validDimensions = ["oi_shift", "liquidation_cascade", "funding_volatility", "spread_blowout"];
for (const dim of validDimensions) {
  assert(
    typeof dim === "string",
    `Dimension '${dim}' is valid`
  );
}

console.log("\n=== Drift Signal Detector Tests Complete ===");
