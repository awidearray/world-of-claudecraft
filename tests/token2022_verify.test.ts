// Scoped Token-2022 verification (server/token2022_verify.ts): the realm-token
// payment parser accepts ONLY Token-2022 balances for the given mint (the exact
// inverse gate of the legacy parseSplitPayment, pinned side by side), the
// jsonParsed mint decoder surfaces authorities + the boring-profile extensions,
// and the Jupiter Lock VestingEscrow decoder round-trips the pinned on-chain
// layout (jup-lock state/vesting_escrow.rs) behind its Anchor discriminator.

import bs58 from 'bs58';
import { describe, expect, it } from 'vitest';
import type { RawConfirmedTransaction } from '../server/solana_rpc';
import { parseSplitPayment, SPL_TOKEN_2022_PROGRAM, SPL_TOKEN_PROGRAM } from '../server/solana_rpc';
import {
  decodeVestingEscrow,
  LOCK_MODE_NEITHER,
  LOCK_TOKEN_PROGRAM_2022,
  parseRealmTokenPayment,
  parseToken2022MintAccount,
  VESTING_ESCROW_ACCOUNT_SIZE,
  VESTING_ESCROW_DISCRIMINATOR,
  type VestingEscrowState,
} from '../server/token2022_verify';

const MINT = 'MoonMint1111111111111111111111111111111111';
const PAYER = 'Payer111111111111111111111111111111111111';
const ESCROW = 'Escrow11111111111111111111111111111111111';

function token2022Tx(over: Partial<RawConfirmedTransaction['meta']> = {}): RawConfirmedTransaction {
  return {
    meta: {
      err: null,
      preTokenBalances: [
        {
          owner: PAYER,
          mint: MINT,
          programId: SPL_TOKEN_2022_PROGRAM,
          uiTokenAmount: { amount: '1000' },
        },
      ],
      postTokenBalances: [
        {
          owner: PAYER,
          mint: MINT,
          programId: SPL_TOKEN_2022_PROGRAM,
          uiTokenAmount: { amount: '400' },
        },
        {
          owner: ESCROW,
          mint: MINT,
          programId: SPL_TOKEN_2022_PROGRAM,
          uiTokenAmount: { amount: '600' },
        },
      ],
      ...over,
    },
    transaction: {
      message: {
        accountKeys: [{ pubkey: PAYER }, { pubkey: ESCROW }],
        instructions: [{ program: 'spl-memo', parsed: 'quote-42' }],
      },
    },
  };
}

describe('parseRealmTokenPayment (scoped Token-2022 parser)', () => {
  it('accepts Token-2022 deltas the legacy parser hard-rejects', () => {
    const tx = token2022Tx();
    const scoped = parseRealmTokenPayment(tx, MINT);
    expect(scoped.succeeded).toBe(true);
    expect(scoped.feePayer).toBe(PAYER);
    expect(scoped.memo).toBe('quote-42');
    expect(scoped.tokenDeltas.get(ESCROW)).toBe(600n);
    expect(scoped.tokenDeltas.get(PAYER)).toBe(-600n);

    // The SAME transaction under the legacy verifier: flagged as Token-2022,
    // which every stake/buy/presale path rejects outright. The gates stay
    // inverse and scoped, exactly as PRD section 3.8 requires.
    const legacy = parseSplitPayment(tx, MINT);
    expect(legacy.usesToken2022ForMint).toBe(true);
  });

  it('ignores legacy-program balances and other mints', () => {
    const tx = token2022Tx({
      postTokenBalances: [
        {
          owner: ESCROW,
          mint: MINT,
          programId: SPL_TOKEN_PROGRAM,
          uiTokenAmount: { amount: '600' },
        },
        {
          owner: ESCROW,
          mint: 'OtherMint111111111111111111111111111111111',
          programId: SPL_TOKEN_2022_PROGRAM,
          uiTokenAmount: { amount: '999' },
        },
      ],
      preTokenBalances: [],
    });
    const scoped = parseRealmTokenPayment(tx, MINT);
    expect(scoped.tokenDeltas.size).toBe(0);
  });

  it('reports a reverted transaction as failed', () => {
    const scoped = parseRealmTokenPayment(token2022Tx({ err: { code: 1 } }), MINT);
    expect(scoped.succeeded).toBe(false);
  });
});

describe('parseToken2022MintAccount', () => {
  const goodValue = {
    owner: SPL_TOKEN_2022_PROGRAM,
    data: {
      program: 'spl-token-2022',
      parsed: {
        type: 'mint',
        info: {
          decimals: 9,
          supply: '1000000000000000000',
          mintAuthority: null,
          freezeAuthority: null,
          extensions: [
            {
              extension: 'metadataPointer',
              state: { authority: null, metadataAddress: MINT },
            },
            {
              extension: 'tokenMetadata',
              state: { name: 'Moon', symbol: 'MOON', uri: '', updateAuthority: PAYER },
            },
          ],
        },
      },
    },
  };

  it('decodes the boring metadata-only profile', () => {
    const state = parseToken2022MintAccount(goodValue);
    expect(state).not.toBeNull();
    if (!state) return;
    expect(state.ownerProgram).toBe(SPL_TOKEN_2022_PROGRAM);
    expect(state.supply).toBe(1_000_000_000_000_000_000n);
    expect(state.mintAuthority).toBeNull();
    expect(state.freezeAuthority).toBeNull();
    expect(state.metadataPointer).toEqual({ authority: null, metadataAddress: MINT });
    expect(state.tokenMetadata?.symbol).toBe('MOON');
    expect(state.extraExtensions).toEqual([]);
  });

  it('surfaces rug-vector extensions as extras', () => {
    const value = structuredClone(goodValue);
    value.data.parsed.info.extensions.push(
      { extension: 'transferFeeConfig', state: {} } as never,
      { extension: 'permanentDelegate', state: {} } as never,
    );
    const state = parseToken2022MintAccount(value);
    expect(state?.extraExtensions).toEqual(['transferFeeConfig', 'permanentDelegate']);
  });

  it('returns null on malformed shapes rather than a partial state', () => {
    expect(parseToken2022MintAccount(null)).toBeNull();
    expect(parseToken2022MintAccount({ owner: SPL_TOKEN_2022_PROGRAM })).toBeNull();
    const notMint = structuredClone(goodValue);
    notMint.data.parsed.type = 'account';
    expect(parseToken2022MintAccount(notMint)).toBeNull();
    const badSupply = structuredClone(goodValue);
    badSupply.data.parsed.info.supply = '1e18';
    expect(parseToken2022MintAccount(badSupply)).toBeNull();
  });
});

// ── VestingEscrow decode ─────────────────────────────────────────────────────

// Encode a VestingEscrow account buffer per the pinned jup-lock layout: the
// 8-byte discriminator, four pubkeys, four u8 modes + 4 padding, then the nine
// u64 words and the 80-byte tail buffer.
function encodeEscrow(s: VestingEscrowState & { creatorB58?: string }): Buffer {
  const buf = Buffer.alloc(VESTING_ESCROW_ACCOUNT_SIZE);
  VESTING_ESCROW_DISCRIMINATOR.copy(buf, 0);
  Buffer.from(bs58.decode(s.recipient)).copy(buf, 8);
  Buffer.from(bs58.decode(s.tokenMint)).copy(buf, 40);
  Buffer.from(bs58.decode(s.creator)).copy(buf, 72);
  Buffer.from(bs58.decode(s.creator)).copy(buf, 104); // base: any pubkey
  buf.writeUInt8(s.escrowBump, 136);
  buf.writeUInt8(s.updateRecipientMode, 137);
  buf.writeUInt8(s.cancelMode, 138);
  buf.writeUInt8(s.tokenProgramFlag, 139);
  buf.writeBigUInt64LE(s.cliffTime, 144);
  buf.writeBigUInt64LE(s.frequency, 152);
  buf.writeBigUInt64LE(s.cliffUnlockAmount, 160);
  buf.writeBigUInt64LE(s.amountPerPeriod, 168);
  buf.writeBigUInt64LE(s.numberOfPeriod, 176);
  buf.writeBigUInt64LE(s.totalClaimedAmount, 184);
  buf.writeBigUInt64LE(s.vestingStartTime, 192);
  buf.writeBigUInt64LE(s.cancelledAt, 200);
  return buf;
}

const RECIPIENT = bs58.encode(Buffer.alloc(32, 7));
const LOCK_MINT = bs58.encode(Buffer.alloc(32, 9));
const CREATOR = bs58.encode(Buffer.alloc(32, 11));

const escrowFixture: VestingEscrowState = {
  recipient: RECIPIENT,
  tokenMint: LOCK_MINT,
  creator: CREATOR,
  escrowBump: 254,
  updateRecipientMode: LOCK_MODE_NEITHER,
  cancelMode: LOCK_MODE_NEITHER,
  tokenProgramFlag: LOCK_TOKEN_PROGRAM_2022,
  cliffTime: 1_790_000_000n,
  frequency: 2_629_746n,
  cliffUnlockAmount: 40n,
  amountPerPeriod: 2_500_000_000n,
  numberOfPeriod: 36n,
  totalClaimedAmount: 0n,
  vestingStartTime: 1_758_000_000n,
  cancelledAt: 0n,
};

describe('decodeVestingEscrow', () => {
  it('round-trips the pinned jup-lock layout', () => {
    const decoded = decodeVestingEscrow(encodeEscrow(escrowFixture));
    expect(decoded).toEqual(escrowFixture);
  });

  it('rejects a wrong discriminator and a truncated account', () => {
    const buf = encodeEscrow(escrowFixture);
    const wrongDisc = Buffer.from(buf);
    wrongDisc[0] ^= 0xff;
    expect(decodeVestingEscrow(wrongDisc)).toBeNull();
    expect(decodeVestingEscrow(buf.subarray(0, VESTING_ESCROW_ACCOUNT_SIZE - 1))).toBeNull();
  });

  it('decodes u64 fields beyond Number.MAX_SAFE_INTEGER exactly', () => {
    const big = {
      ...escrowFixture,
      amountPerPeriod: 18_000_000_000_000_000_000n,
      numberOfPeriod: 1n,
    };
    const decoded = decodeVestingEscrow(encodeEscrow(big));
    expect(decoded?.amountPerPeriod).toBe(18_000_000_000_000_000_000n);
  });
});
