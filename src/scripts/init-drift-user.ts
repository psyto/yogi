import {
  DriftClient,
  Wallet,
  initialize,
} from "@drift-labs/sdk";
import { Connection } from "@solana/web3.js";
import { getConnection, loadKeypair } from "../utils/helpers";

async function main() {
  console.log("Initializing Drift user account for manager...\n");

  const connection = getConnection();
  const manager = loadKeypair("MANAGER_KEYPAIR_PATH");

  console.log(`Manager: ${manager.publicKey.toBase58()}`);

  const wallet = new Wallet(manager);

  const driftClient = new DriftClient({
    connection,
    wallet,
    accountSubscription: {
      type: "websocket",
    },
  });

  await driftClient.subscribe();
  console.log("Drift client connected.");

  // Initialize user stats + user account
  const [txSig] = await driftClient.initializeUserAccountAndDepositCollateral(
    BigInt(0), // no deposit
    await driftClient.getSpotMarketAccount(0)!.pubkey, // USDC spot market vault
    undefined,
    0, // sub-account 0
    "Yogi Keeper",
    undefined,
    undefined,
  ).catch(async () => {
    // Try simpler init if the above fails
    console.log("Trying simple initializeUser...");
    const sig = await driftClient.initializeUserAccount(0, "Yogi Keeper");
    return [sig];
  });

  console.log(`\nDrift user initialized! Signature: ${txSig}`);

  await driftClient.unsubscribe();
}

main().catch(console.error);
