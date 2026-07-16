// Jupiter Lock integration (launchpad phase 3): the immutable vesting escrows
// behind the founder / levy / treasury buckets. We talk to the DEPLOYED
// program (LocpQgucEQHbqNABEYvBvwoxCPsSbG91A1QaQhQQqjn, audited, zero-fee)
// directly: a pure builder for create_vesting_escrow_v2 (the Token-2022-aware
// variant) and a pure decoder for the VestingEscrow account, both transcribed
// from the program's own on-chain Anchor IDL (v0.4.0, fetched from the
// deployed program; the GitHub repo's checked-in IDL is stale). The account
// layout was additionally validated byte-for-byte against a live devnet
// escrow before this module was written.
//
// Immutability is the point: an escrow with update_recipient_mode == 0 and
// cancel_mode == 0 can never be redirected or cancelled by anyone, which is
// the "founder cannot dump, platform cannot dump" guarantee the listing gate
// verifies on-chain.

import { PublicKey, TransactionInstruction } from '@solana/web3.js';
import type { LockParams } from './realm_token_alloc';

export const JUP_LOCK_PROGRAM = new PublicKey('LocpQgucEQHbqNABEYvBvwoxCPsSbG91A1QaQhQQqjn');
const ASSOCIATED_TOKEN_PROGRAM = new PublicKey('ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL');
const SYSTEM_PROGRAM = new PublicKey('11111111111111111111111111111111');

// Anchor discriminators from the deployed IDL. sha256("global:create_vesting_escrow_v2")[0..8]
// and sha256("account:VestingEscrow")[0..8] respectively.
const CREATE_VESTING_ESCROW_V2_DISC = Uint8Array.from([181, 155, 104, 183, 182, 128, 35, 47]);
export const VESTING_ESCROW_DISC = Uint8Array.from([244, 119, 183, 4, 73, 116, 135, 195]);

// update_recipient_mode / cancel_mode value 0 = NeitherCreatorOrRecipient:
// nobody can ever update the recipient or cancel the escrow. The only values
// this codebase ever writes or accepts.
export const MODE_IMMUTABLE = 0;

export function deriveEscrowPda(base: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync(
    [Buffer.from('escrow'), base.toBuffer()],
    JUP_LOCK_PROGRAM,
  )[0];
}

function deriveEventAuthority(): PublicKey {
  return PublicKey.findProgramAddressSync([Buffer.from('__event_authority')], JUP_LOCK_PROGRAM)[0];
}

// The escrow's token account is the escrow PDA's ATA under the mint's token
// program (the IDL derives it with the ATA program's seeds).
export function escrowTokenAta(
  escrow: PublicKey,
  mint: PublicKey,
  tokenProgram: PublicKey,
): PublicKey {
  return PublicKey.findProgramAddressSync(
    [escrow.toBuffer(), tokenProgram.toBuffer(), mint.toBuffer()],
    ASSOCIATED_TOKEN_PROGRAM,
  )[0];
}

function u64le(v: bigint): Buffer {
  const b = Buffer.alloc(8);
  b.writeBigUInt64LE(v);
  return b;
}

// create_vesting_escrow_v2, deployed-IDL account order. Args are the 8-field
// CreateVestingEscrowParameters plus a Borsh None for remaining_accounts_info
// (no transfer-hook accounts: the founder token never has hooks).
export function buildCreateVestingEscrowV2Ix(args: {
  base: PublicKey; // ephemeral, must co-sign; escrow = PDA("escrow", base)
  sender: PublicKey; // the founder: funds the escrow, pays fees
  senderToken: PublicKey; // the founder's Token-2022 ATA for the mint
  recipient: PublicKey;
  mint: PublicKey;
  tokenProgram: PublicKey;
  params: LockParams;
}): TransactionInstruction {
  const escrow = deriveEscrowPda(args.base);
  const data = Buffer.concat([
    CREATE_VESTING_ESCROW_V2_DISC,
    u64le(args.params.vestingStartTime),
    u64le(args.params.cliffTime),
    u64le(args.params.frequency),
    u64le(args.params.cliffUnlockAmount),
    u64le(args.params.amountPerPeriod),
    u64le(args.params.numberOfPeriod),
    Buffer.from([MODE_IMMUTABLE]), // update_recipient_mode
    Buffer.from([MODE_IMMUTABLE]), // cancel_mode
    Buffer.from([0]), // Option<RemainingAccountsInfo>: None
  ]);
  return new TransactionInstruction({
    programId: JUP_LOCK_PROGRAM,
    keys: [
      { pubkey: args.base, isSigner: true, isWritable: true },
      { pubkey: escrow, isSigner: false, isWritable: true },
      { pubkey: args.mint, isSigner: false, isWritable: false },
      {
        pubkey: escrowTokenAta(escrow, args.mint, args.tokenProgram),
        isSigner: false,
        isWritable: true,
      },
      { pubkey: args.sender, isSigner: true, isWritable: true },
      { pubkey: args.senderToken, isSigner: false, isWritable: true },
      { pubkey: args.recipient, isSigner: false, isWritable: false },
      { pubkey: args.tokenProgram, isSigner: false, isWritable: false },
      { pubkey: SYSTEM_PROGRAM, isSigner: false, isWritable: false },
      { pubkey: deriveEventAuthority(), isSigner: false, isWritable: false },
      { pubkey: JUP_LOCK_PROGRAM, isSigner: false, isWritable: false },
    ],
    data,
  });
}

// ── VestingEscrow account decoder ─────────────────────────────────────────────

// bytemuck repr(C) layout, 296 bytes: discriminator(8), recipient(32),
// token_mint(32), creator(32), base(32), escrow_bump(1),
// update_recipient_mode(1), cancel_mode(1), token_program_flag(1),
// padding(4), then u64s: cliff_time, frequency, cliff_unlock_amount,
// amount_per_period, number_of_period, total_claimed_amount,
// vesting_start_time, cancelled_at, padding, buffer[u128;5].
export const VESTING_ESCROW_SIZE = 296;

export interface VestingEscrowAccount {
  recipient: string;
  tokenMint: string;
  creator: string;
  base: string;
  updateRecipientMode: number;
  cancelMode: number;
  tokenProgramFlag: number; // 0 = legacy SPL, 1 = Token-2022
  cliffTime: bigint;
  frequency: bigint;
  cliffUnlockAmount: bigint;
  amountPerPeriod: bigint;
  numberOfPeriod: bigint;
  totalClaimedAmount: bigint;
  vestingStartTime: bigint;
  cancelledAt: bigint;
}

// PURE. Null when the buffer is not a VestingEscrow (wrong size or
// discriminator), so a caller can never mis-verify an arbitrary account.
export function decodeVestingEscrow(data: Uint8Array): VestingEscrowAccount | null {
  if (data.length < VESTING_ESCROW_SIZE) return null;
  for (let i = 0; i < 8; i++) if (data[i] !== VESTING_ESCROW_DISC[i]) return null;
  const buf = Buffer.from(data.buffer, data.byteOffset, data.length);
  const pk = (offset: number): string =>
    new PublicKey(buf.subarray(offset, offset + 32)).toBase58();
  return {
    recipient: pk(8),
    tokenMint: pk(40),
    creator: pk(72),
    base: pk(104),
    updateRecipientMode: buf[137],
    cancelMode: buf[138],
    tokenProgramFlag: buf[139],
    cliffTime: buf.readBigUInt64LE(144),
    frequency: buf.readBigUInt64LE(152),
    cliffUnlockAmount: buf.readBigUInt64LE(160),
    amountPerPeriod: buf.readBigUInt64LE(168),
    numberOfPeriod: buf.readBigUInt64LE(176),
    totalClaimedAmount: buf.readBigUInt64LE(184),
    vestingStartTime: buf.readBigUInt64LE(192),
    cancelledAt: buf.readBigUInt64LE(200),
  };
}

// ── Lock verification (pure) ──────────────────────────────────────────────────

export type LockVerdict = { ok: true } | { ok: false; reason: string };

// Verify a decoded escrow against the exact pinned launch expectations: right
// mint and recipient, IMMUTABLE (nobody can update the recipient or cancel),
// never cancelled, Token-2022 funded, and carrying exactly the pinned vesting
// numbers (a founder who signed a doctored transaction fails here and the
// token simply never lists).
export function verifyLockedEscrow(
  escrow: VestingEscrowAccount,
  expect: {
    mint: string;
    recipient: string;
    params: LockParams;
  },
): LockVerdict {
  if (escrow.tokenMint !== expect.mint) return { ok: false, reason: 'lock_mismatch' };
  if (escrow.recipient !== expect.recipient) return { ok: false, reason: 'lock_mismatch' };
  if (escrow.updateRecipientMode !== MODE_IMMUTABLE || escrow.cancelMode !== MODE_IMMUTABLE) {
    return { ok: false, reason: 'lock_not_immutable' };
  }
  if (escrow.cancelledAt !== 0n) return { ok: false, reason: 'lock_not_immutable' };
  if (escrow.tokenProgramFlag !== 1) return { ok: false, reason: 'lock_mismatch' };
  const p = expect.params;
  if (
    escrow.cliffTime !== p.cliffTime ||
    escrow.frequency !== p.frequency ||
    escrow.cliffUnlockAmount !== p.cliffUnlockAmount ||
    escrow.amountPerPeriod !== p.amountPerPeriod ||
    escrow.numberOfPeriod !== p.numberOfPeriod ||
    escrow.vestingStartTime !== p.vestingStartTime
  ) {
    return { ok: false, reason: 'lock_mismatch' };
  }
  return { ok: true };
}

// Verify a VENUE-created locker escrow (the founder vesting the bonding-curve
// migration creates through this same program). The venue's escrow profile,
// read off a live devnet graduation, differs from our own immutable locks in
// two sound ways: update_recipient_mode is OnlyRecipient (2), letting the
// beneficiary redirect their own vesting (not a rug vector), and cancel_mode
// is OnlyCreator (1) where the CREATOR is an off-curve program PDA that can
// never sign (no cancel instruction exists), so cancellation is unreachable.
// Everything else stays strict: right mint and recipient, never cancelled,
// Token-2022 funded, and the locked total equals the pinned bucket exactly.
export function verifyVenueLockerEscrow(
  escrow: VestingEscrowAccount,
  expect: { mint: string; recipient: string; totalBase: bigint },
): LockVerdict {
  if (escrow.tokenMint !== expect.mint) return { ok: false, reason: 'lock_mismatch' };
  if (escrow.recipient !== expect.recipient) return { ok: false, reason: 'lock_mismatch' };
  if (escrow.cancelledAt !== 0n) return { ok: false, reason: 'lock_not_immutable' };
  if (escrow.tokenProgramFlag !== 1) return { ok: false, reason: 'lock_mismatch' };
  if (escrow.updateRecipientMode !== MODE_IMMUTABLE && escrow.updateRecipientMode !== 2) {
    return { ok: false, reason: 'lock_not_immutable' };
  }
  if (escrow.cancelMode !== MODE_IMMUTABLE) {
    const creatorCanNeverSign = !PublicKey.isOnCurve(new PublicKey(escrow.creator).toBytes());
    if (escrow.cancelMode !== 1 || !creatorCanNeverSign) {
      return { ok: false, reason: 'lock_not_immutable' };
    }
  }
  const total = escrow.cliffUnlockAmount + escrow.amountPerPeriod * escrow.numberOfPeriod;
  if (total !== expect.totalBase) return { ok: false, reason: 'lock_mismatch' };
  return { ok: true };
}
