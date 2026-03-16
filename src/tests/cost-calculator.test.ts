import {
  evaluateTradeEconomics,
  passesCostGate,
  minProfitableFundingBps,
} from "../keeper/cost-calculator";

function assert(condition: boolean, msg: string) {
  if (!condition) {
    console.error(`  FAIL: ${msg}`);
    process.exitCode = 1;
  } else {
    console.log(`  PASS: ${msg}`);
  }
}

console.log("=== Cost Calculator Tests (v3 — Maker Orders) ===\n");

// With maker orders: round-trip = 2 × max(0, slippage + makerRebate)
// = 2 × max(0, 1 + (-0.2)) = 2 × 0.8 = 1.6 bps
// Break-even for 7-day hold: 1.6 × 8760 / 168 = 83 bps = 0.83% APY

// Test 1: High funding should be profitable
console.log("Trade economics (maker):");
const highFunding = evaluateTradeEconomics(2000); // 20% APY
assert(highFunding.profitable, "20% APY should be profitable with maker fees");
assert(highFunding.orderType === "maker", "Should be using maker orders");

// Test 2: Very low funding should fail
const lowFunding = evaluateTradeEconomics(10); // 0.1% APY
assert(!lowFunding.profitable, "0.1% APY should NOT be profitable");

// Test 3: Break-even analysis
console.log("\nBreak-even analysis (maker):");
const minBps7d = minProfitableFundingBps(168);
const minBps24h = minProfitableFundingBps(24);
console.log(`  Min for 7-day hold: ${minBps7d.toFixed(0)} bps (${(minBps7d / 100).toFixed(2)}% APY)`);
console.log(`  Min for 24h hold: ${minBps24h.toFixed(0)} bps (${(minBps24h / 100).toFixed(2)}% APY)`);
assert(minBps7d < 100, "7-day hold should need < 1% APY with maker fees");
assert(minBps24h < 700, "24h hold should need < 7% APY with maker fees");
assert(minBps7d < minBps24h, "Longer hold should need lower funding");

// Test 4: Round-trip cost should be ~1.6 bps with maker
const econ = evaluateTradeEconomics(1000);
console.log(`\n  Round-trip cost: ${econ.roundTripCostBps.toFixed(1)} bps (maker)`);
assert(
  econ.roundTripCostBps < 3,
  `Maker round-trip should be < 3 bps (got ${econ.roundTripCostBps.toFixed(1)})`
);

// Test 5: Cost gate — much more markets pass with maker fees
console.log("\nCost gate (maker):");
assert(passesCostGate(2000), "20% APY should pass");
assert(passesCostGate(500), "5% APY should pass with maker fees (7-day hold)");
assert(!passesCostGate(5), "0.05% APY should NOT pass");

// Test 6: 20% APY profitable for 24h with maker (was NOT profitable with taker)
console.log("\nMaker vs Taker comparison:");
const maker24h = evaluateTradeEconomics(2000, 24);
assert(
  maker24h.profitable,
  `20% APY / 24h hold: profitable with maker (net=${maker24h.netProfitBps.toFixed(1)} bps)`
);

console.log("\n=== Cost Calculator Tests Complete ===");
