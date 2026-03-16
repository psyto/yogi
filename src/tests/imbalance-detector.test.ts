import {
  fetchMarketImbalances,
  rankByImbalance,
  getTradeDirection,
  MarketImbalance,
} from "../keeper/imbalance-detector";

function assert(condition: boolean, msg: string) {
  if (!condition) {
    console.error(`  FAIL: ${msg}`);
    process.exitCode = 1;
  } else {
    console.log(`  PASS: ${msg}`);
  }
}

// Helper to create mock imbalance data
function mockImbalance(overrides: Partial<MarketImbalance>): MarketImbalance {
  return {
    market: "TEST-PERP",
    marketIndex: 0,
    oraclePrice: 100,
    markPrice: 100,
    premiumPct: 0,
    longOI: 1000000,
    shortOI: 1000000,
    oiImbalancePct: 0,
    totalOI: 2000000,
    fundingRate24h: 0,
    annualizedFundingPct: 0,
    signal: "neutral",
    signalStrength: 0,
    ...overrides,
  };
}

console.log("=== Imbalance Detector Tests ===\n");

// Test 1: Strong short signal — high funding + mark > oracle + long-heavy OI
console.log("Strong short signal:");
const strongShort = mockImbalance({
  market: "SOL-PERP",
  fundingRate24h: 0.003, // High positive funding
  premiumPct: 0.1, // Mark above oracle
  oiImbalancePct: 15, // Longs dominate
  signal: "strong_short",
  signalStrength: 80,
});
const shortDir = getTradeDirection(strongShort);
assert(shortDir.direction === "short", `Should be SHORT (got ${shortDir.direction})`);
assert(shortDir.confidence > 20, `Confidence should be > 20 (got ${shortDir.confidence})`);
assert(shortDir.reason.includes("SHORT"), `Reason should mention SHORT: ${shortDir.reason}`);

// Test 2: Strong long signal — negative funding + mark < oracle + short-heavy OI
console.log("\nStrong long signal:");
const strongLong = mockImbalance({
  market: "BTC-PERP",
  fundingRate24h: -0.003, // Negative funding
  premiumPct: -0.1, // Mark below oracle (discount)
  oiImbalancePct: -15, // Shorts dominate
  signal: "strong_long",
  signalStrength: 80,
});
const longDir = getTradeDirection(strongLong);
assert(longDir.direction === "long", `Should be LONG (got ${longDir.direction})`);
assert(longDir.reason.includes("LONG"), `Reason should mention LONG: ${longDir.reason}`);

// Test 3: Neutral — conflicting signals
console.log("\nNeutral (conflicting signals):");
const neutral = mockImbalance({
  market: "ETH-PERP",
  fundingRate24h: 0.001, // Slightly positive
  premiumPct: -0.05, // But mark below oracle (conflicting)
  oiImbalancePct: -5, // And short-heavy (conflicting)
  signal: "neutral",
  signalStrength: 5,
});
const neutralDir = getTradeDirection(neutral);
assert(neutralDir.direction === "none", `Should be NONE (got ${neutralDir.direction})`);

// Test 4: Weak signal below minimum strength
console.log("\nWeak signal (below threshold):");
const weak = mockImbalance({
  market: "DOGE-PERP",
  fundingRate24h: 0.0005, // Very small positive
  premiumPct: 0.01,
  oiImbalancePct: 2,
  signal: "moderate_short",
  signalStrength: 10, // Below minSignalStrength (20)
});
const weakDir = getTradeDirection(weak);
assert(weakDir.direction === "none", `Weak signal should be NONE (got ${weakDir.direction})`);
assert(weakDir.reason.includes("weak"), `Reason should mention weak: ${weakDir.reason}`);

// Test 5: Ranking filters excluded markets
console.log("\nMarket filtering:");
const markets: MarketImbalance[] = [
  mockImbalance({ market: "SOL-PERP", marketIndex: 0, signal: "strong_short", signalStrength: 80, totalOI: 10000000 }),
  mockImbalance({ market: "1MBONK-PERP", marketIndex: 14, signal: "strong_short", signalStrength: 90, totalOI: 100000 }),
  mockImbalance({ market: "BTC-PERP", marketIndex: 1, signal: "moderate_long", signalStrength: 50, totalOI: 50000000 }),
  mockImbalance({ market: "RANDOM-PERP", marketIndex: 99, signal: "strong_short", signalStrength: 95, totalOI: 1000000 }),
];
const ranked = rankByImbalance(markets);
assert(
  !ranked.find((m) => m.market === "1MBONK-PERP"),
  "1MBONK-PERP should be excluded (in excludeMarkets)"
);
assert(
  !ranked.find((m) => m.market === "RANDOM-PERP"),
  "RANDOM-PERP should be excluded (not in allowedMarkets)"
);
assert(ranked.length <= 3, `Should have at most 3 results (got ${ranked.length})`);

// Test 6: Neutral signals filtered from ranking
console.log("\nNeutral filtering:");
const withNeutral: MarketImbalance[] = [
  mockImbalance({ market: "SOL-PERP", marketIndex: 0, signal: "neutral", signalStrength: 5, totalOI: 10000000 }),
  mockImbalance({ market: "BTC-PERP", marketIndex: 1, signal: "strong_short", signalStrength: 70, totalOI: 50000000 }),
];
const rankedNoNeutral = rankByImbalance(withNeutral);
assert(
  !rankedNoNeutral.find((m) => m.market === "SOL-PERP"),
  "Neutral signals should be excluded from ranking"
);
assert(rankedNoNeutral.length === 1, `Should have 1 result (got ${rankedNoNeutral.length})`);

// Test 7: Sorted by signal strength descending
console.log("\nSort order:");
const toSort: MarketImbalance[] = [
  mockImbalance({ market: "SOL-PERP", marketIndex: 0, signal: "moderate_short", signalStrength: 40, totalOI: 10000000 }),
  mockImbalance({ market: "BTC-PERP", marketIndex: 1, signal: "strong_short", signalStrength: 80, totalOI: 50000000 }),
  mockImbalance({ market: "ETH-PERP", marketIndex: 2, signal: "moderate_long", signalStrength: 60, totalOI: 20000000 }),
];
const sorted = rankByImbalance(toSort);
if (sorted.length >= 2) {
  assert(
    sorted[0].signalStrength >= sorted[1].signalStrength,
    `First should have highest strength (${sorted[0].signalStrength} >= ${sorted[1].signalStrength})`
  );
}

// Test 8: Direction reason includes signal components
console.log("\nReason details:");
const detailed = mockImbalance({
  market: "SOL-PERP",
  fundingRate24h: 0.002,
  premiumPct: 0.05,
  oiImbalancePct: 10,
  signal: "strong_short",
  signalStrength: 75,
});
const detailedDir = getTradeDirection(detailed);
assert(detailedDir.reason.includes("funding"), `Reason should include funding: ${detailedDir.reason}`);
assert(detailedDir.reason.includes("premium"), `Reason should include premium: ${detailedDir.reason}`);
assert(detailedDir.reason.includes("OI"), `Reason should include OI: ${detailedDir.reason}`);

console.log("\n=== Imbalance Detector Tests Complete ===");
