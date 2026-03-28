/**
 * One-time cleanup: sell orphaned SOL and ETH spot positions.
 * These are leftover from the directional-to-DN transition.
 * Does NOT touch the BTC DN position (spot + perp pair).
 *
 * Usage: npx tsx src/scripts/cleanup-orphaned-spot.ts
 */

import { Connection, Keypair } from "@solana/web3.js";
import {
  DriftClient,
  Wallet,
  PositionDirection,
  OrderType,
  MarketType,
  getUserAccountPublicKeySync,
  BN,
} from "@drift-labs/sdk";
import { getConnection, loadKeypair } from "../utils/helpers";
import { DRIFT_PROGRAM_ID, BASE_PRECISION, PRICE_PRECISION } from "../config/constants";
import { PublicKey } from "@solana/web3.js";

const VAULT_STRATEGY_AUTH = new PublicKey(
  "4dvzQ6Hux3YFJuWUcdqgYRddJFa8yo5EDzL7a49PyxLB"
);

// Orphaned spot to sell (from Drift UI)
const ORPHANED_SPOTS = [
  { name: "SOL", spotIndex: 1, sizeCoins: 0.24 },
  { name: "ETH", spotIndex: 3, sizeCoins: 0.007 },
];

// DO NOT TOUCH — these are the BTC DN pair
const PROTECTED = {
  btcSpotIndex: 2,  // BTC spot (DN hedge)
  btcPerpIndex: 1,  // BTC perp (DN short)
};

async function main() {
  console.log("=== Cleanup Orphaned Spot Positions ===\n");
  console.log("Will sell: SOL (0.24) and ETH (0.007) spot");
  console.log("Protected: BTC spot (DN hedge) and BTC perp (DN short)\n");

  const connection = getConnection();
  const keypair = loadKeypair("MANAGER_KEYPAIR_PATH");

  const wallet = new Wallet(keypair);
  const driftClient = new DriftClient({
    connection,
    wallet,
    programID: DRIFT_PROGRAM_ID,
    activeSubAccountId: 0,
    authoritySubAccountMap: new Map([
      [VAULT_STRATEGY_AUTH.toBase58(), [0]],
    ]),
    accountSubscription: { type: "websocket" },
    skipLoadUsers: false,
    perpMarketIndexes: [0, 1, 2],
    spotMarketIndexes: [0, 1, 2, 3, 5],
  });

  await driftClient.subscribe();
  await driftClient.addUser(0, VAULT_STRATEGY_AUTH);
  await driftClient.switchActiveUser(0, VAULT_STRATEGY_AUTH);

  const user = driftClient.getUser();
  const equityBefore = user.getTotalCollateral().toNumber() / 1e6;
  console.log(`Equity before: $${equityBefore.toFixed(2)}\n`);

  for (const spot of ORPHANED_SPOTS) {
    // Safety check: don't touch BTC
    if (spot.spotIndex === PROTECTED.btcSpotIndex) {
      console.log(`SKIPPING ${spot.name} — protected BTC DN position`);
      continue;
    }

    console.log(`Selling ${spot.sizeCoins} ${spot.name} (spot index ${spot.spotIndex})...`);

    try {
      const baseAmount = new BN(Math.floor(spot.sizeCoins * BASE_PRECISION));

      const tx = await driftClient.placeSpotOrder({
        orderType: OrderType.MARKET,
        marketType: MarketType.SPOT,
        marketIndex: spot.spotIndex,
        direction: PositionDirection.SHORT,
        baseAssetAmount: baseAmount,
      });

      console.log(`  Sold ${spot.name} | tx: ${tx}`);
    } catch (e) {
      console.error(`  Failed to sell ${spot.name}:`, e);
    }
  }

  // Wait for settlement
  await new Promise((r) => setTimeout(r, 3000));

  const equityAfter = user.getTotalCollateral().toNumber() / 1e6;
  console.log(`\nEquity after: $${equityAfter.toFixed(2)}`);
  console.log(`Recovered: $${(equityAfter - equityBefore).toFixed(2)}`);
  console.log("\nDone. BTC DN position untouched.");

  process.exit(0);
}

main().catch((e) => {
  console.error("Fatal:", e);
  process.exit(1);
});
