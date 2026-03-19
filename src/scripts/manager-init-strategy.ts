import {
  PublicKey,
  SYSVAR_RENT_PUBKEY,
} from "@solana/web3.js";
import { VoltrClient } from "@voltr/vault-sdk";
import BN from "bn.js";
import {
  DRIFT_ADAPTOR_PROGRAM_ID,
  DRIFT_PROGRAM_ID,
  DRIFT_SPOT_STATE,
  DISCRIMINATORS,
} from "../config/constants";
import { vaultAddress } from "../config/vault";
import {
  getConnection,
  loadKeypair,
  sendAndConfirmTx,
} from "../utils/helpers";

async function main() {
  console.log("Initializing Drift User strategy for Yogi Vault...\n");

  const connection = getConnection();
  const manager = loadKeypair("MANAGER_KEYPAIR_PATH");

  const vc = new VoltrClient(connection, manager);

  // Derive strategy PDA for Drift User
  const [strategy] = PublicKey.findProgramAddressSync(
    [Buffer.from("drift_user")],
    DRIFT_ADAPTOR_PROGRAM_ID
  );

  console.log(`Vault: ${vaultAddress.toBase58()}`);
  console.log(`Strategy: ${strategy.toBase58()}`);

  // Find vault strategy addresses
  const { vaultStrategyAuth } = vc.findVaultStrategyAddresses(
    vaultAddress,
    strategy
  );

  // Derive Drift user accounts from vaultStrategyAuth
  const [driftUserStats] = PublicKey.findProgramAddressSync(
    [Buffer.from("user_stats"), vaultStrategyAuth.toBuffer()],
    DRIFT_PROGRAM_ID
  );
  const [driftUser] = PublicKey.findProgramAddressSync(
    [
      Buffer.from("user"),
      vaultStrategyAuth.toBuffer(),
      new BN(0).toArrayLike(Buffer, "le", 2),
    ],
    DRIFT_PROGRAM_ID
  );

  console.log(`Vault Strategy Auth: ${vaultStrategyAuth.toBase58()}`);
  console.log(`Drift User Stats: ${driftUserStats.toBase58()}`);
  console.log(`Drift User: ${driftUser.toBase58()}`);

  // Fetch vault name from on-chain account (raw 32-byte array)
  const vaultAccount = await vc.fetchVaultAccount(vaultAddress);
  const vaultNameBuffer = Buffer.from(vaultAccount.name);
  console.log(`Vault name: ${vaultNameBuffer.toString("utf-8").trim()}`);

  // Build additional args: raw vault name bytes (32) + enableMarginTrading (1 byte)
  const enableMarginTradingBuffer = Buffer.from([1]); // Enable margin trading for perps
  const additionalArgs = Buffer.concat([vaultNameBuffer, enableMarginTradingBuffer]);

  // Following the official voltrxyz/drift-scripts pattern:
  // - manager field = vault's on-chain manager (signer)
  // - remainingAccounts = [driftProgram, userStats, user, driftState, delegatee, rent]
  const initStrategyIx = await vc.createInitializeStrategyIx(
    {
      instructionDiscriminator: Buffer.from(DISCRIMINATORS.INITIALIZE_USER),
      additionalArgs,
    },
    {
      payer: manager.publicKey,
      vault: vaultAddress,
      manager: manager.publicKey,
      strategy,
      adaptorProgram: DRIFT_ADAPTOR_PROGRAM_ID,
      remainingAccounts: [
        { pubkey: DRIFT_PROGRAM_ID, isSigner: false, isWritable: false },
        { pubkey: driftUserStats, isSigner: false, isWritable: true },
        { pubkey: driftUser, isSigner: false, isWritable: true },
        { pubkey: DRIFT_SPOT_STATE, isSigner: false, isWritable: true },
        { pubkey: manager.publicKey, isSigner: false, isWritable: false },
        { pubkey: SYSVAR_RENT_PUBKEY, isSigner: false, isWritable: false },
      ],
    }
  );

  const sig = await sendAndConfirmTx(connection, [initStrategyIx], manager);
  console.log(`\nDrift User strategy initialized! Signature: ${sig}`);
}

main().catch(console.error);
