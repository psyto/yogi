import { rankMarketsByFunding, FundingRateData } from "../keeper/funding-scanner";

function assert(condition: boolean, msg: string) {
  if (!condition) {
    console.error(`  FAIL: ${msg}`);
    process.exitCode = 1;
  } else {
    console.log(`  PASS: ${msg}`);
  }
}

console.log("=== Funding Scanner Tests ===\n");

// Mock data
const mockRates: FundingRateData[] = [
  {
    market: "SOL-PERP",
    marketIndex: 0,
    rate24h: -0.001,
    rate7d: -0.0005,
    rate30d: -0.0003,
    rate1y: 0.0001,
    annualizedPct: -876,
    openInterest: 0,
  },
  {
    market: "BTC-PERP",
    marketIndex: 1,
    rate24h: 0.002,
    rate7d: 0.0015,
    rate30d: 0.001,
    rate1y: 0.0008,
    annualizedPct: 1752,
    openInterest: 0,
  },
  {
    market: "DOGE-PERP",
    marketIndex: 15,
    rate24h: 0.005,
    rate7d: 0.004,
    rate30d: 0.003,
    rate1y: 0.002,
    annualizedPct: 4380,
    openInterest: 0,
  },
  {
    market: "THIN-PERP",
    marketIndex: 50,
    rate24h: 0.0001,
    rate7d: -0.00005,
    rate30d: -0.0001,
    rate1y: 0.00001,
    annualizedPct: 87.6,
    openInterest: 0,
  },
];

// Test 1: Negative funding markets should be excluded
console.log("Market filtering:");
const ranked = rankMarketsByFunding(mockRates, 500);
assert(
  !ranked.find((r) => r.market === "SOL-PERP"),
  "SOL-PERP (negative funding) should be excluded"
);

// Test 2: Markets above threshold should be included
assert(
  ranked.find((r) => r.market === "BTC-PERP") !== undefined,
  "BTC-PERP (positive, >5%) should be included"
);
assert(
  ranked.find((r) => r.market === "DOGE-PERP") !== undefined,
  "DOGE-PERP (positive, >5%) should be included"
);

// Test 3: Thin markets should be excluded (only 1 positive timeframe)
assert(
  !ranked.find((r) => r.market === "THIN-PERP"),
  "THIN-PERP (only 1 positive timeframe, below threshold) should be excluded"
);

// Test 4: Ranking order — highest weighted score first
console.log("\nRanking order:");
assert(ranked.length === 2, `Should have 2 eligible markets (got ${ranked.length})`);
if (ranked.length >= 2) {
  assert(
    ranked[0].market === "DOGE-PERP",
    `DOGE should rank first (highest score), got ${ranked[0].market}`
  );
  assert(
    ranked[1].market === "BTC-PERP",
    `BTC should rank second, got ${ranked[1].market}`
  );
}

// Test 5: Empty input
const empty = rankMarketsByFunding([], 500);
assert(empty.length === 0, "Empty input should return empty");

// Test 6: All negative
const allNeg: FundingRateData[] = [
  { ...mockRates[0], market: "A" },
  { ...mockRates[0], market: "B" },
];
const noResults = rankMarketsByFunding(allNeg, 500);
assert(noResults.length === 0, "All negative funding should return empty");

console.log("\n=== Funding Scanner Tests Complete ===");
