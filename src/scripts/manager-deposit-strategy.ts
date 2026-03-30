import {
  PublicKey,
  TransactionInstruction,
  AddressLookupTableAccount,
  TransactionMessage,
  VersionedTransaction,
} from "@solana/web3.js";
import {
  createAssociatedTokenAccountIdempotentInstruction,
  getAssociatedTokenAddressSync,
} from "@solana/spl-token";
import { DriftClient, Wallet } from "@drift-labs/sdk";
import { VoltrClient } from "@voltr/vault-sdk";
import BN from "bn.js";
import {
  DRIFT_ADAPTOR_PROGRAM_ID,
  DRIFT_PROGRAM_ID,
  DRIFT_SPOT_STATE,
  DRIFT_LOOKUP_TABLE,
  USDC_MINT,
  SPL_TOKEN_PROGRAM_ID,
  DISCRIMINATORS,
} from "../config/constants";
import { vaultAddress } from "../config/vault";
import { getConnection, loadKeypair } from "../utils/helpers";

const DEPOSIT_AMOUNT = new BN(399 * 1e6); // 399 USDC
const USDC_MARKET_INDEX = 0;

async function main() {
  console.log("Depositing vault funds into Drift strategy...\n");

  const connection = getConnection();
  const manager = loadKeypair("MANAGER_KEYPAIR_PATH");

  const vc = new VoltrClient(connection, manager);

  console.log(`Vault: ${vaultAddress.toBase58()}`);
  console.log(`Manager: ${manager.publicKey.toBase58()}`);
  console.log(`Amount: ${DEPOSIT_AMOUNT.toNumber() / 1e6} USDC`);

  // Derive strategy PDA
  const [strategy] = PublicKey.findProgramAddressSync(
    [Buffer.from("drift_user")],
    DRIFT_ADAPTOR_PROGRAM_ID
  );

  const { vaultStrategyAuth } = vc.findVaultStrategyAddresses(
    vaultAddress,
    strategy
  );

  // Derive Drift accounts
  const [userStats] = PublicKey.findProgramAddressSync(
    [Buffer.from("user_stats"), vaultStrategyAuth.toBuffer()],
    DRIFT_PROGRAM_ID
  );
  const [user] = PublicKey.findProgramAddressSync(
    [
      Buffer.from("user"),
      vaultStrategyAuth.toBuffer(),
      new BN(0).toArrayLike(Buffer, "le", 2),
    ],
    DRIFT_PROGRAM_ID
  );
  const [counterPartyTa] = PublicKey.findProgramAddressSync(
    [
      Buffer.from("spot_market_vault"),
      new BN(USDC_MARKET_INDEX).toArrayLike(Buffer, "le", 2),
    ],
    DRIFT_PROGRAM_ID
  );

  console.log(`Strategy: ${strategy.toBase58()}`);
  console.log(`Vault Strategy Auth: ${vaultStrategyAuth.toBase58()}`);

  const ixs: TransactionInstruction[] = [];

  // Ensure vault strategy auth has USDC ATA
  const vaultStrategyAssetAta = getAssociatedTokenAddressSync(
    USDC_MINT,
    vaultStrategyAuth,
    true,
    SPL_TOKEN_PROGRAM_ID
  );
  ixs.push(
    createAssociatedTokenAccountIdempotentInstruction(
      manager.publicKey,
      vaultStrategyAssetAta,
      vaultStrategyAuth,
      USDC_MINT,
      SPL_TOKEN_PROGRAM_ID
    )
  );

  // Get Drift remaining accounts (oracles, spot/perp markets)
  const driftClient = new DriftClient({
    connection,
    wallet: new Wallet(manager),
    env: "mainnet-beta",
    skipLoadUsers: true,
  });
  await driftClient.subscribe();

  const userAccounts = await driftClient.getUserAccountsForAuthority(
    vaultStrategyAuth
  );

  const driftRemainingAccounts = driftClient.getRemainingAccounts({
    userAccounts,
    useMarketLastSlotCache: false,
    writableSpotMarketIndexes: [USDC_MARKET_INDEX],
  });

  await driftClient.unsubscribe();

  // Build remaining accounts in the order the adaptor expects
  const remainingAccounts = [
    { pubkey: counterPartyTa, isSigner: false, isWritable: true },
    { pubkey: DRIFT_PROGRAM_ID, isSigner: false, isWritable: false },
    { pubkey: userStats, isSigner: false, isWritable: true },
    { pubkey: user, isSigner: false, isWritable: true },
    { pubkey: DRIFT_SPOT_STATE, isSigner: false, isWritable: false },
    ...driftRemainingAccounts,
  ];

  // Additional args: market index as u16 LE
  const additionalArgs = Buffer.from(
    new BN(USDC_MARKET_INDEX).toArrayLike(Buffer, "le", 2)
  );

  const depositStrategyIx = await vc.createDepositStrategyIx(
    {
      instructionDiscriminator: Buffer.from(DISCRIMINATORS.DEPOSIT_USER),
      depositAmount: DEPOSIT_AMOUNT,
      additionalArgs,
    },
    {
      manager: manager.publicKey,
      vault: vaultAddress,
      vaultAssetMint: USDC_MINT,
      assetTokenProgram: SPL_TOKEN_PROGRAM_ID,
      strategy,
      remainingAccounts,
      adaptorProgram: DRIFT_ADAPTOR_PROGRAM_ID,
    }
  );
  ixs.push(depositStrategyIx);

  // Use Drift lookup table to fit all accounts
  const lookupTableAccount = await connection
    .getAddressLookupTable(DRIFT_LOOKUP_TABLE)
    .then((res) => res.value);

  const lookupTables: AddressLookupTableAccount[] = lookupTableAccount
    ? [lookupTableAccount]
    : [];

  // Send as versioned transaction with lookup table
  const { blockhash, lastValidBlockHeight } =
    await connection.getLatestBlockhash("confirmed");

  const message = new TransactionMessage({
    payerKey: manager.publicKey,
    recentBlockhash: blockhash,
    instructions: ixs,
  }).compileToV0Message(lookupTables);

  const tx = new VersionedTransaction(message);
  tx.sign([manager]);

  const simulation = await connection.simulateTransaction(tx);
  if (simulation.value.err) {
    console.error("Simulation failed:", simulation.value.err);
    console.error("Logs:", simulation.value.logs);
    throw new Error(`Simulation failed: ${JSON.stringify(simulation.value.err)}`);
  }

  const sig = await connection.sendTransaction(tx, {
    skipPreflight: false,
    maxRetries: 3,
  });

  await connection.confirmTransaction(
    { signature: sig, blockhash, lastValidBlockHeight },
    "confirmed"
  );

  console.log(`\nDeposit to Drift strategy successful! Signature: ${sig}`);
}

main().catch(console.error);
