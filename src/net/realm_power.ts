// Client-side builder for a power-realm token-to-copper credit (launchpad
// phase 7). The payment is ONE Token-2022 transfer of the quoted realm-token
// amount into the realm treasury sink, tagged with the quoteId memo so the
// server can bind the finalized transfer to its quote (server/realm_power.ts
// verifies via the scoped Token-2022 parser). Pure (no wallet/network),
// mirroring src/net/realm_presale.ts; the wallet send wrapper is
// signAndSendPowerCredit in src/net/wallet.ts.
//
// Realm tokens live under the Token-2022 program (the phase 3 factory / DBC
// profile), so the ATA derivation and the TransferChecked instruction both
// target TOKEN_2022_PROGRAM_ID; the instruction ENCODING is byte-identical to
// the legacy program's.

import { PublicKey, TransactionInstruction } from '@solana/web3.js';
import { memoIx } from './realm_buy';

export const TOKEN_2022_PROGRAM_ID = new PublicKey('TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb');
const ATA_PROGRAM_ID = new PublicKey('ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL');
const SYSTEM_PROGRAM_ID = new PublicKey('11111111111111111111111111111111');

// The owner's associated token account for a Token-2022 mint.
export function ownerToken2022Account(owner: PublicKey, mint: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync(
    [owner.toBuffer(), TOKEN_2022_PROGRAM_ID.toBuffer(), mint.toBuffer()],
    ATA_PROGRAM_ID,
  )[0];
}

// ATA CreateIdempotent (discriminator 1) under the Token-2022 program: a no-op
// when the sink's ATA already exists; the payer funds the rent otherwise.
export function createToken2022AtaIdempotentIx(
  payer: PublicKey,
  owner: PublicKey,
  mint: PublicKey,
): TransactionInstruction {
  return new TransactionInstruction({
    programId: ATA_PROGRAM_ID,
    keys: [
      { pubkey: payer, isSigner: true, isWritable: true },
      { pubkey: ownerToken2022Account(owner, mint), isSigner: false, isWritable: true },
      { pubkey: owner, isSigner: false, isWritable: false },
      { pubkey: mint, isSigner: false, isWritable: false },
      { pubkey: SYSTEM_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: TOKEN_2022_PROGRAM_ID, isSigner: false, isWritable: false },
    ],
    data: Buffer.from([1]),
  });
}

// Token-2022 TransferChecked (tag 12): u8 tag + u64 amount(LE) + u8 decimals.
export function token2022TransferCheckedIx(
  source: PublicKey,
  mint: PublicKey,
  dest: PublicKey,
  owner: PublicKey,
  amountBase: bigint,
  decimals: number,
): TransactionInstruction {
  const data = Buffer.alloc(10);
  data.writeUInt8(12, 0);
  data.writeBigUInt64LE(amountBase, 1);
  data.writeUInt8(decimals, 9);
  return new TransactionInstruction({
    programId: TOKEN_2022_PROGRAM_ID,
    keys: [
      { pubkey: source, isSigner: false, isWritable: true },
      { pubkey: mint, isSigner: false, isWritable: false },
      { pubkey: dest, isSigner: false, isWritable: true },
      { pubkey: owner, isSigner: true, isWritable: false },
    ],
    data,
  });
}

export interface PowerCreditPlan {
  payer: PublicKey;
  mint: PublicKey;
  sinkWallet: PublicKey;
  amountBase: bigint;
  memo: string; // the quoteId
}

// Build the credit payment: idempotent sink ATA, the checked transfer of the
// exact quoted amount (realm tokens are fixed at 9 decimals), and the binding
// memo.
export function buildPowerCreditInstructions(plan: PowerCreditPlan): TransactionInstruction[] {
  return [
    createToken2022AtaIdempotentIx(plan.payer, plan.sinkWallet, plan.mint),
    token2022TransferCheckedIx(
      ownerToken2022Account(plan.payer, plan.mint),
      plan.mint,
      ownerToken2022Account(plan.sinkWallet, plan.mint),
      plan.payer,
      plan.amountBase,
      9,
    ),
    memoIx(plan.memo),
  ];
}
