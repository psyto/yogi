import {
  PublicKey,
  TransactionInstruction,
} from "@solana/web3.js";
import {
  getAssociatedTokenAddressSync,
  createAssociatedTokenAccountIdempotentInstruction,
} from "@solana/spl-token";
import BN from "bn.js";
import { VoltrClient } from "@voltr/vault-sdk";
import { USDC_MINT, SPL_TOKEN_PROGRAM_ID } from "../config/constants";
import { vaultAddress } from "../config/vault";
import { getConnection, loadKeypair, sendAndConfirmTx } from "../utils/helpers";

const DEPOSIT_AMOUNT = new BN(100 * 1e6); // 100 USDC

async function main() {
  console.log("Depositing into Yogi Vault...\n");

  const connection = getConnection();
  const user = loadKeypair("ADMIN_KEYPAIR_PATH");

  const vc = new VoltrClient(connection, user);

  console.log(`Vault: ${vaultAddress.toBase58()}`);
  console.log(`User: ${user.publicKey.toBase58()}`);
  console.log(`Amount: ${DEPOSIT_AMOUNT.toNumber() / 1e6} USDC`);

  const ixs: TransactionInstruction[] = [];

  // Ensure user has LP token ATA (to receive vault LP tokens)
  const { vaultLpMint } = vc.findVaultAddresses(vaultAddress);
  const userLpAta = getAssociatedTokenAddressSync(vaultLpMint, user.publicKey);
  ixs.push(
    createAssociatedTokenAccountIdempotentInstruction(
      user.publicKey,
      userLpAta,
      user.publicKey,
      vaultLpMint
    )
  );

  // Create deposit instruction
  const depositIx = await vc.createDepositVaultIx(DEPOSIT_AMOUNT, {
    vault: vaultAddress,
    userTransferAuthority: user.publicKey,
    vaultAssetMint: USDC_MINT,
    assetTokenProgram: SPL_TOKEN_PROGRAM_ID,
  });
  ixs.push(depositIx);

  const sig = await sendAndConfirmTx(connection, ixs, user);
  console.log(`\nDeposit successful! Signature: ${sig}`);
}

main().catch(console.error);
