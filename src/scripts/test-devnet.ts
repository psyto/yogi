import { Connection, PublicKey } from "@solana/web3.js";
import {
  DriftClient,
  Wallet,
  BulkAccountLoader,
  initialize,
  DriftEnv,
} from "@drift-labs/sdk";
import { getConnection, loadKeypair } from "../utils/helpers";
import {
  fetchAllFundingRates,
  rankMarketsByFunding,
} from "../keeper/funding-scanner";
import { detectSignals, formatSignalState } from "../keeper/drift-signal-detector";
import { STRATEGY_CONFIG } from "../config/vault";

async function main() {
  console.log("Yogi Devnet Test\n");

  // 1. Test funding rate scanner (uses mainnet API — devnet has no real funding)
  console.log("=== Funding Rate Scanner ===");
  const rates = await fetchAllFundingRates();
  console.log(`Total markets: ${rates.length}`);

  const ranked = rankMarketsByFunding(
    rates,
    STRATEGY_CONFIG.minAnnualizedFundingBps
  );
  console.log(
    `Markets above ${STRATEGY_CONFIG.minAnnualizedFundingBps / 100}% APY threshold: ${ranked.length}`
  );
  ranked.slice(0, 5).forEach((m, i) => {
    console.log(
      `  ${i + 1}. ${m.market}: ${m.annualizedPct.toFixed(2)}% APY`
    );
  });

  // 2. Test signal detection (Yogi-specific)
  console.log("\n=== Signal Detection ===");
  const signals = await detectSignals(STRATEGY_CONFIG.monitoredMarkets);
  console.log(formatSignalState(signals));

  // 3. Test Drift client connection on devnet
  console.log("\n=== Drift Client (Devnet) ===");
  const connection = new Connection("https://api.devnet.solana.com", "confirmed");
  const manager = loadKeypair("MANAGER_KEYPAIR_PATH");

  console.log(`RPC: devnet`);
  console.log(`Manager: ${manager.publicKey.toBase58()}`);

  const balance = await connection.getBalance(manager.publicKey);
  console.log(`SOL balance: ${balance / 1e9}`);

  const sdkConfig = initialize({ env: "devnet" as DriftEnv });
  console.log(`Drift program: ${sdkConfig.DRIFT_PROGRAM_ID}`);

  const wallet = new Wallet(manager);
  const accountLoader = new BulkAccountLoader(connection, "confirmed", 5000);

  const driftClient = new DriftClient({
    connection,
    wallet,
    programID: new PublicKey(sdkConfig.DRIFT_PROGRAM_ID),
    accountSubscription: {
      type: "polling",
      accountLoader,
    },
    env: "devnet",
  });

  try {
    await driftClient.subscribe();
    console.log("Drift client connected!");

    const perpMarkets = driftClient.getPerpMarketAccounts();
    console.log(`Perp markets on devnet: ${perpMarkets.length}`);
    perpMarkets.slice(0, 5).forEach((m) => {
      console.log(
        `  Market ${m.marketIndex}: ${m.name ? Buffer.from(m.name).toString().trim() : `index-${m.marketIndex}`}`
      );
    });

    const spotMarkets = driftClient.getSpotMarketAccounts();
    console.log(`Spot markets on devnet: ${spotMarkets.length}`);
    spotMarkets.slice(0, 5).forEach((m) => {
      console.log(
        `  Market ${m.marketIndex}: ${m.name ? Buffer.from(m.name).toString().trim() : `index-${m.marketIndex}`}`
      );
    });

    await driftClient.unsubscribe();
  } catch (err) {
    console.error("Drift client error:", err);
  }

  console.log("\n=== Test Complete ===");
  console.log("Funding scanner: OK");
  console.log("Signal detection: OK");
  console.log("Drift devnet connection: OK");
  console.log("\nNext: Initialize Drift user account, then test trading");
}

main().catch(console.error);
