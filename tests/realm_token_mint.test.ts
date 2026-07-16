// Launchpad phase 3 (Token-2022 mint factory + allocation locks): the scoped
// Token-2022 movement parser and mint rug summary against jsonParsed fixtures,
// the Jupiter Lock instruction encoding + account decoding + immutability
// verdicts, the three-step quote/confirm orchestration against in-memory
// fakes (every rejection path), the listing gate, and a source-level pin that
// the mint factory never persists or returns key material (the transient
// keypairs sign and are discarded).

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Keypair, PublicKey, Transaction } from '@solana/web3.js';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  buildCreateVestingEscrowV2Ix,
  decodeVestingEscrow,
  deriveEscrowPda,
  escrowTokenAta,
  JUP_LOCK_PROGRAM,
  MODE_IMMUTABLE,
  VESTING_ESCROW_DISC,
  VESTING_ESCROW_SIZE,
  type VestingEscrowAccount,
  verifyLockedEscrow,
} from '../server/jup_lock';
import type { PresaleConfig, RealmPresaleStore } from '../server/realm_presale';
import type {
  MonetizationPolicy,
  RealmToken,
  RealmTokenDb,
  RealmTokenStatus,
} from '../server/realm_token';
import {
  computeAllocation,
  DEFAULT_ALLOCATION_BPS,
  type LockParams,
  lockParams,
  lockTotalBase,
  tokenSupplyBase,
} from '../server/realm_token_alloc';
import {
  confirmDistribution,
  confirmLock,
  confirmMintCreated,
  type LaunchChain,
  type LaunchDeps,
  type LaunchQuoteRow,
  type LaunchQuoteStore,
  launchStatus,
  markTokenLive,
  prepareDistributionQuote,
  prepareLockQuote,
  prepareMintQuote,
  REALM_TOKEN_DECIMALS,
} from '../server/realm_token_mint';
import type { RawConfirmedTransaction } from '../server/solana_rpc';
import {
  mintRugSummary,
  narrowParsedMint,
  type ParsedMintInfo,
  parseToken2022Movement,
  TOKEN_2022_PROGRAM,
} from '../server/solana_token2022';

// Deterministic real keypairs (web3.js) so every address is valid base58.
const FOUNDER = Keypair.fromSeed(new Uint8Array(32).fill(1)).publicKey.toBase58();
const ESCROW_WALLET = Keypair.fromSeed(new Uint8Array(32).fill(2)).publicKey.toBase58();
const LEVY_WALLET = Keypair.fromSeed(new Uint8Array(32).fill(3)).publicKey.toBase58();
const MINT = Keypair.fromSeed(new Uint8Array(32).fill(4)).publicKey.toBase58();
const OTHER = Keypair.fromSeed(new Uint8Array(32).fill(5)).publicKey.toBase58();
const SIG = '5'.repeat(80);
const SIG2 = '6'.repeat(80);
const BLOCKHASH = Keypair.fromSeed(new Uint8Array(32).fill(9)).publicKey.toBase58();

// ── Fixtures ──────────────────────────────────────────────────────────────────

interface BalanceRow {
  owner: string;
  mint: string;
  programId: string;
  uiTokenAmount: { amount: string };
}

function t22Row(owner: string, amount: string, over: Partial<BalanceRow> = {}): BalanceRow {
  return { owner, mint: MINT, programId: TOKEN_2022_PROGRAM, uiTokenAmount: { amount }, ...over };
}

function makeTx(opts: {
  feePayer?: string;
  memo?: string | null;
  err?: unknown;
  pre?: BalanceRow[];
  post?: BalanceRow[];
}): RawConfirmedTransaction {
  const instructions: Array<{ program?: string; parsed?: unknown }> = [];
  if (opts.memo !== null && opts.memo !== undefined) {
    instructions.push({ program: 'spl-memo', parsed: opts.memo });
  }
  return {
    meta: {
      err: opts.err ?? null,
      preTokenBalances: opts.pre ?? [],
      postTokenBalances: opts.post ?? [],
    },
    transaction: {
      message: { accountKeys: [opts.feePayer ?? FOUNDER, OTHER], instructions },
    },
  };
}

function cleanParsedMint(over: Partial<ParsedMintInfo> = {}): ParsedMintInfo {
  return {
    program: 'spl-token-2022',
    decimals: REALM_TOKEN_DECIMALS,
    supplyBase: 0n,
    mintAuthority: FOUNDER,
    freezeAuthority: null,
    extensions: [{ extension: 'metadataPointer' }, { extension: 'tokenMetadata' }],
    metadata: { name: 'MOON', symbol: 'MOON', uri: '', updateAuthority: FOUNDER },
    metadataPointer: { authority: null, metadataAddress: MINT },
    ...over,
  };
}

// A 296-byte VestingEscrow account buffer with the given fields.
function escrowBuffer(e: Partial<VestingEscrowAccount> & { recipient: string }): Uint8Array {
  const buf = Buffer.alloc(VESTING_ESCROW_SIZE);
  Buffer.from(VESTING_ESCROW_DISC).copy(buf, 0);
  new PublicKey(e.recipient).toBuffer().copy(buf, 8);
  new PublicKey(e.tokenMint ?? MINT).toBuffer().copy(buf, 40);
  new PublicKey(e.creator ?? FOUNDER).toBuffer().copy(buf, 72);
  new PublicKey(e.base ?? OTHER).toBuffer().copy(buf, 104);
  buf[136] = 255;
  buf[137] = e.updateRecipientMode ?? MODE_IMMUTABLE;
  buf[138] = e.cancelMode ?? MODE_IMMUTABLE;
  buf[139] = e.tokenProgramFlag ?? 1;
  buf.writeBigUInt64LE(e.cliffTime ?? 0n, 144);
  buf.writeBigUInt64LE(e.frequency ?? 0n, 152);
  buf.writeBigUInt64LE(e.cliffUnlockAmount ?? 0n, 160);
  buf.writeBigUInt64LE(e.amountPerPeriod ?? 0n, 168);
  buf.writeBigUInt64LE(e.numberOfPeriod ?? 0n, 176);
  buf.writeBigUInt64LE(e.totalClaimedAmount ?? 0n, 184);
  buf.writeBigUInt64LE(e.vestingStartTime ?? 0n, 192);
  buf.writeBigUInt64LE(e.cancelledAt ?? 0n, 200);
  return Uint8Array.from(buf);
}

// ── In-memory fakes ───────────────────────────────────────────────────────────

class UniqueViolation extends Error {}
const isFakeUnique = (err: unknown): boolean => err instanceof UniqueViolation;

function token(realmId: number, over: Partial<RealmToken> = {}): RealmToken {
  return {
    realmId,
    mint: null,
    decimals: 9,
    symbol: 'MOON',
    icon: '',
    status: 'funded',
    monetizationPolicy: 'cosmetic',
    curveAddress: null,
    poolAddress: null,
    lpLockAddress: null,
    feeClaimerPda: null,
    launchTxSig: null,
    distributeTxSig: null,
    supplyBase: null,
    founderAllocBase: null,
    levyAllocBase: null,
    treasuryAllocBase: null,
    founderLockAddress: null,
    levyLockAddress: null,
    treasuryLockAddress: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...over,
  };
}

class FakeTokens implements RealmTokenDb {
  rows = new Map<number, RealmToken>();
  async getRealmToken(realmId: number) {
    return this.rows.get(realmId) ?? null;
  }
  async insertRealmToken(t: {
    realmId: number;
    symbol: string;
    icon: string;
    monetizationPolicy: MonetizationPolicy;
  }) {
    const row = token(t.realmId, { symbol: t.symbol, status: 'prelaunch' });
    this.rows.set(t.realmId, row);
    return row;
  }
  async listRealmTokens() {
    return new Map<number, RealmToken>();
  }
  async setRealmTokenStatus(
    realmId: number,
    from: readonly RealmTokenStatus[],
    to: RealmTokenStatus,
  ) {
    const row = this.rows.get(realmId);
    if (!row || !from.includes(row.status)) return null;
    const next = { ...row, status: to };
    this.rows.set(realmId, next);
    return next;
  }
  async recordMintCreated(realmId: number, mint: string, launchTxSig: string) {
    const row = this.rows.get(realmId);
    if (!row || row.mint !== null || row.status !== 'funded') return null;
    for (const r of this.rows.values()) {
      if (r.launchTxSig === launchTxSig) throw new UniqueViolation('launch_tx_sig');
    }
    const next = { ...row, mint, launchTxSig };
    this.rows.set(realmId, next);
    return next;
  }
  async recordDistribution(
    realmId: number,
    d: {
      distributeTxSig: string;
      supplyBase: bigint;
      founderAllocBase: bigint;
      levyAllocBase: bigint;
      treasuryAllocBase: bigint;
    },
  ) {
    const row = this.rows.get(realmId);
    if (!row || row.distributeTxSig !== null || row.mint === null) return null;
    for (const r of this.rows.values()) {
      if (r.distributeTxSig === d.distributeTxSig) throw new UniqueViolation('distribute_tx_sig');
    }
    const next = { ...row, ...d };
    this.rows.set(realmId, next);
    return next;
  }
  async recordLockAddress(
    realmId: number,
    bucket: 'founder' | 'levy' | 'treasury',
    address: string,
  ) {
    const row = this.rows.get(realmId);
    if (!row || row.distributeTxSig === null) return null;
    const key =
      bucket === 'founder'
        ? ('founderLockAddress' as const)
        : bucket === 'levy'
          ? ('levyLockAddress' as const)
          : ('treasuryLockAddress' as const);
    if (row[key] !== null) return null;
    const next = { ...row, [key]: address };
    this.rows.set(realmId, next);
    return next;
  }
  async recordCurveLaunch(
    realmId: number,
    d: {
      mint: string;
      launchTxSig: string;
      curveAddress: string;
      poolAddress: string;
      feeClaimerPda: string;
      supplyBase: bigint;
      founderAllocBase: bigint;
      levyAllocBase: bigint;
      treasuryAllocBase: bigint;
    },
  ) {
    const row = this.rows.get(realmId);
    if (!row || row.mint !== null || row.curveAddress !== null || row.status !== 'funded')
      return null;
    for (const r of this.rows.values()) {
      if (r.launchTxSig === d.launchTxSig) throw new UniqueViolation('launch_tx_sig');
    }
    const next = { ...row, ...d };
    this.rows.set(realmId, next);
    return next;
  }
  async recordLpLock(realmId: number, address: string) {
    const row = this.rows.get(realmId);
    if (!row || row.lpLockAddress !== null || row.poolAddress === null) return null;
    const next = { ...row, lpLockAddress: address };
    this.rows.set(realmId, next);
    return next;
  }
  async listByStatus(): Promise<Array<RealmToken & { realmName: string }>> {
    throw new Error('listByStatus is not exercised by this suite');
  }
}

class FakeQuotes implements LaunchQuoteStore {
  rows = new Map<string, LaunchQuoteRow>();
  async createQuote(q: LaunchQuoteRow) {
    this.rows.set(q.quoteId, q);
  }
  async getQuote(quoteId: string) {
    return this.rows.get(quoteId) ?? null;
  }
  async deleteQuote(quoteId: string) {
    this.rows.delete(quoteId);
  }
}

class FakeChain implements LaunchChain {
  tx: RawConfirmedTransaction | null = null;
  mint: ParsedMintInfo | null = null;
  accountData: Uint8Array | null = null;
  tokenBalance: bigint | null = null;
  async fetchTx() {
    return this.tx;
  }
  async fetchMint() {
    return this.mint;
  }
  async fetchAccountData() {
    return this.accountData;
  }
  async fetchTokenBalanceBase() {
    return this.tokenBalance;
  }
  async latestBlockhash() {
    return BLOCKHASH;
  }
  async rentExemptLamports() {
    return 3_000_000;
  }
}

function makeDeps(over: Partial<LaunchDeps> = {}): LaunchDeps & {
  tokens: FakeTokens;
  quotes: FakeQuotes;
  chain: FakeChain;
} {
  const tokens = new FakeTokens();
  const quotes = new FakeQuotes();
  const chain = new FakeChain();
  const presale: PresaleConfig = {
    realmId: 7,
    escrowWallet: ESCROW_WALLET,
    rails: {},
    createdAt: new Date(),
  };
  return {
    tokens,
    quotes,
    chain,
    presales: {
      getPresale: async (realmId: number) => (realmId === 7 ? presale : null),
    } as Pick<RealmPresaleStore, 'getPresale'>,
    walletForAccount: async (accountId: number) => (accountId === 1 ? { pubkey: FOUNDER } : null),
    rolesForAccountOnRealm: async (_realmId: number, accountId: number) =>
      accountId === 1 ? ['owner'] : [],
    isUniqueViolation: isFakeUnique,
    ...over,
  } as LaunchDeps & { tokens: FakeTokens; quotes: FakeQuotes; chain: FakeChain };
}

beforeEach(() => {
  process.env.REALM_TOKEN_LEVY_WALLET = LEVY_WALLET;
});

// ── Scoped Token-2022 parser ──────────────────────────────────────────────────

describe('parseToken2022Movement', () => {
  it('reduces Token-2022 deltas per owner and reads memo + fee payer', () => {
    const tx = makeTx({
      memo: 'q1',
      pre: [t22Row(FOUNDER, '100')],
      post: [t22Row(FOUNDER, '40'), t22Row(OTHER, '60')],
    });
    const p = parseToken2022Movement(tx, MINT);
    expect(p.succeeded).toBe(true);
    expect(p.memo).toBe('q1');
    expect(p.feePayer).toBe(FOUNDER);
    expect(p.sawForeignProgramForMint).toBe(false);
    expect(p.tokenDeltas.get(FOUNDER)).toBe(-60n);
    expect(p.tokenDeltas.get(OTHER)).toBe(60n);
  });

  it('flags a balance row for the mint under the LEGACY program', () => {
    const legacy = t22Row(OTHER, '60', {
      programId: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
    });
    const p = parseToken2022Movement(makeTx({ post: [legacy] }), MINT);
    expect(p.sawForeignProgramForMint).toBe(true);
    expect(p.tokenDeltas.size).toBe(0);
  });

  it('ignores other mints and reports failed transactions', () => {
    const other = t22Row(OTHER, '60', { mint: OTHER });
    const p = parseToken2022Movement(makeTx({ err: { failed: true }, post: [other] }), MINT);
    expect(p.succeeded).toBe(false);
    expect(p.tokenDeltas.size).toBe(0);
  });
});

describe('narrowParsedMint + mintRugSummary', () => {
  const rawMint = (info: Record<string, unknown>) => ({
    owner: TOKEN_2022_PROGRAM,
    data: { program: 'spl-token-2022', parsed: { type: 'mint', info } },
  });

  it('narrows the jsonParsed shape and scores a boring mint clean', () => {
    const parsed = narrowParsedMint(
      rawMint({
        decimals: 9,
        supply: '1000',
        mintAuthority: null,
        freezeAuthority: null,
        extensions: [
          { extension: 'metadataPointer', state: { metadataAddress: MINT } },
          {
            extension: 'tokenMetadata',
            state: { name: 'MOON', symbol: 'MOON', uri: '', updateAuthority: undefined },
          },
        ],
      }),
    );
    expect(parsed).not.toBeNull();
    expect(parsed?.supplyBase).toBe(1000n);
    expect(parsed?.mintAuthority).toBeNull();
    const summary = mintRugSummary(MINT, parsed as ParsedMintInfo);
    expect(summary.clean).toBe(true);
    expect(summary.forbiddenExtensions).toEqual([]);
  });

  it('rejects non-mint accounts', () => {
    expect(narrowParsedMint(null)).toBeNull();
    expect(
      narrowParsedMint({ data: { program: 'spl-token-2022', parsed: { type: 'account' } } }),
    ).toBeNull();
  });

  it('scores each rug vector dirty', () => {
    const clean = cleanParsedMint({
      mintAuthority: null,
      metadata: { name: 'MOON', symbol: 'MOON', uri: '', updateAuthority: null },
    });
    expect(mintRugSummary(MINT, clean).clean).toBe(true);
    // live mint authority
    expect(mintRugSummary(MINT, { ...clean, mintAuthority: FOUNDER }).clean).toBe(false);
    // freeze authority set
    expect(mintRugSummary(MINT, { ...clean, freezeAuthority: FOUNDER }).clean).toBe(false);
    // mutable metadata
    expect(
      mintRugSummary(MINT, {
        ...clean,
        metadata: { name: 'MOON', symbol: 'MOON', uri: '', updateAuthority: FOUNDER },
      }).clean,
    ).toBe(false);
    // pointer at a foreign account
    expect(
      mintRugSummary(MINT, {
        ...clean,
        metadataPointer: { authority: null, metadataAddress: OTHER },
      }).clean,
    ).toBe(false);
    // a forbidden extension (transfer fee)
    const dirty = mintRugSummary(MINT, {
      ...clean,
      extensions: [...clean.extensions, { extension: 'transferFeeConfig' }],
    });
    expect(dirty.clean).toBe(false);
    expect(dirty.forbiddenExtensions).toEqual(['transferFeeConfig']);
    // legacy program look-alike
    expect(mintRugSummary(MINT, { ...clean, program: 'spl-token' }).clean).toBe(false);
  });
});

// ── Jupiter Lock encode / decode / verify ─────────────────────────────────────

describe('jup_lock', () => {
  const params: LockParams = {
    vestingStartTime: 1_752_000_000n,
    cliffTime: 1_783_000_000n,
    frequency: 2_592_000n,
    cliffUnlockAmount: 7n,
    amountPerPeriod: 1_000n,
    numberOfPeriod: 36n,
  };

  it('encodes create_vesting_escrow_v2 exactly (discriminator, LE params, immutable modes, None)', () => {
    const base = Keypair.fromSeed(new Uint8Array(32).fill(8)).publicKey;
    const ix = buildCreateVestingEscrowV2Ix({
      base,
      sender: new PublicKey(FOUNDER),
      senderToken: new PublicKey(OTHER),
      recipient: new PublicKey(LEVY_WALLET),
      mint: new PublicKey(MINT),
      tokenProgram: new PublicKey(TOKEN_2022_PROGRAM),
      params,
    });
    expect(ix.programId.equals(JUP_LOCK_PROGRAM)).toBe(true);
    expect(ix.data.length).toBe(8 + 6 * 8 + 2 + 1);
    expect(Array.from(ix.data.subarray(0, 8))).toEqual([181, 155, 104, 183, 182, 128, 35, 47]);
    expect(ix.data.readBigUInt64LE(8)).toBe(params.vestingStartTime);
    expect(ix.data.readBigUInt64LE(16)).toBe(params.cliffTime);
    expect(ix.data.readBigUInt64LE(24)).toBe(params.frequency);
    expect(ix.data.readBigUInt64LE(32)).toBe(params.cliffUnlockAmount);
    expect(ix.data.readBigUInt64LE(40)).toBe(params.amountPerPeriod);
    expect(ix.data.readBigUInt64LE(48)).toBe(params.numberOfPeriod);
    expect(ix.data[56]).toBe(MODE_IMMUTABLE);
    expect(ix.data[57]).toBe(MODE_IMMUTABLE);
    expect(ix.data[58]).toBe(0); // Option::None
    // Account order per the deployed IDL: base, escrow, mint, escrow_token,
    // sender, sender_token, recipient, token_program, system, event, program.
    const escrow = deriveEscrowPda(base);
    expect(ix.keys[0].pubkey.equals(base)).toBe(true);
    expect(ix.keys[0].isSigner).toBe(true);
    expect(ix.keys[1].pubkey.equals(escrow)).toBe(true);
    expect(ix.keys[2].pubkey.toBase58()).toBe(MINT);
    expect(
      ix.keys[3].pubkey.equals(
        escrowTokenAta(escrow, new PublicKey(MINT), new PublicKey(TOKEN_2022_PROGRAM)),
      ),
    ).toBe(true);
    expect(ix.keys[4].pubkey.toBase58()).toBe(FOUNDER);
    expect(ix.keys[4].isSigner).toBe(true);
    expect(ix.keys[6].pubkey.toBase58()).toBe(LEVY_WALLET);
    expect(ix.keys[10].pubkey.equals(JUP_LOCK_PROGRAM)).toBe(true);
    expect(ix.keys).toHaveLength(11);
  });

  it('round-trips the escrow account decode', () => {
    const buf = escrowBuffer({
      recipient: LEVY_WALLET,
      tokenMint: MINT,
      cliffTime: params.cliffTime,
      frequency: params.frequency,
      cliffUnlockAmount: params.cliffUnlockAmount,
      amountPerPeriod: params.amountPerPeriod,
      numberOfPeriod: params.numberOfPeriod,
      vestingStartTime: params.vestingStartTime,
    });
    const e = decodeVestingEscrow(buf);
    expect(e).not.toBeNull();
    expect(e?.recipient).toBe(LEVY_WALLET);
    expect(e?.tokenMint).toBe(MINT);
    expect(e?.cliffTime).toBe(params.cliffTime);
    expect(lockTotalBase(e as VestingEscrowAccount)).toBe(7n + 1_000n * 36n);
  });

  it('rejects short buffers and wrong discriminators', () => {
    expect(decodeVestingEscrow(new Uint8Array(100))).toBeNull();
    const wrong = escrowBuffer({ recipient: LEVY_WALLET });
    wrong[0] ^= 0xff;
    expect(decodeVestingEscrow(wrong)).toBeNull();
  });

  it('verifies immutability and exact pinned params', () => {
    const good = decodeVestingEscrow(
      escrowBuffer({
        recipient: LEVY_WALLET,
        tokenMint: MINT,
        cliffTime: params.cliffTime,
        frequency: params.frequency,
        cliffUnlockAmount: params.cliffUnlockAmount,
        amountPerPeriod: params.amountPerPeriod,
        numberOfPeriod: params.numberOfPeriod,
        vestingStartTime: params.vestingStartTime,
      }),
    ) as VestingEscrowAccount;
    const expect_ = { mint: MINT, recipient: LEVY_WALLET, params };
    expect(verifyLockedEscrow(good, expect_)).toEqual({ ok: true });
    expect(verifyLockedEscrow({ ...good, tokenMint: OTHER }, expect_)).toEqual({
      ok: false,
      reason: 'lock_mismatch',
    });
    expect(verifyLockedEscrow({ ...good, recipient: OTHER }, expect_)).toEqual({
      ok: false,
      reason: 'lock_mismatch',
    });
    expect(verifyLockedEscrow({ ...good, updateRecipientMode: 1 }, expect_)).toEqual({
      ok: false,
      reason: 'lock_not_immutable',
    });
    expect(verifyLockedEscrow({ ...good, cancelMode: 3 }, expect_)).toEqual({
      ok: false,
      reason: 'lock_not_immutable',
    });
    expect(verifyLockedEscrow({ ...good, cancelledAt: 5n }, expect_)).toEqual({
      ok: false,
      reason: 'lock_not_immutable',
    });
    expect(verifyLockedEscrow({ ...good, tokenProgramFlag: 0 }, expect_)).toEqual({
      ok: false,
      reason: 'lock_mismatch',
    });
    expect(verifyLockedEscrow({ ...good, amountPerPeriod: 999n }, expect_)).toEqual({
      ok: false,
      reason: 'lock_mismatch',
    });
  });
});

// ── Step 1: mint quote + confirm ──────────────────────────────────────────────

describe('prepareMintQuote', () => {
  it('requires owner, funded status, no prior mint, and a levy wallet', async () => {
    const deps = makeDeps();
    deps.tokens.rows.set(7, token(7));
    expect(await prepareMintQuote(deps, { accountId: 2, realmId: 7 })).toMatchObject({
      ok: false,
      error: 'not_realm_owner',
    });
    deps.tokens.rows.set(7, token(7, { status: 'presale' }));
    expect(await prepareMintQuote(deps, { accountId: 1, realmId: 7 })).toMatchObject({
      ok: false,
      error: 'mint_not_ready',
    });
    deps.tokens.rows.set(7, token(7, { mint: MINT }));
    expect(await prepareMintQuote(deps, { accountId: 1, realmId: 7 })).toMatchObject({
      ok: false,
      error: 'token_already_minted',
    });
    deps.tokens.rows.set(7, token(7));
    delete process.env.REALM_TOKEN_LEVY_WALLET;
    expect(await prepareMintQuote(deps, { accountId: 1, realmId: 7 })).toMatchObject({
      ok: false,
      error: 'levy_wallet_unconfigured',
    });
  });

  it('returns a founder-payable transaction partial-signed by the transient mint keypair', async () => {
    const deps = makeDeps();
    deps.tokens.rows.set(7, token(7));
    const result = await prepareMintQuote(deps, { accountId: 1, realmId: 7 });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const tx = Transaction.from(Buffer.from(result.quote.txBase64, 'base64'));
    expect(tx.feePayer?.toBase58()).toBe(FOUNDER);
    // The mint keypair has already signed; the founder has not.
    const mintSig = tx.signatures.find((s) => s.publicKey.toBase58() === result.quote.mint);
    expect(mintSig?.signature).not.toBeNull();
    const founderSig = tx.signatures.find((s) => s.publicKey.toBase58() === FOUNDER);
    expect(founderSig?.signature ?? null).toBeNull();
    // The stored quote payload pins facts only: never key material.
    const stored = deps.quotes.rows.get(result.quote.quoteId);
    expect(stored?.payload).toEqual({
      mint: result.quote.mint,
      founderWallet: FOUNDER,
      symbol: 'MOON',
    });
  });
});

describe('confirmMintCreated', () => {
  async function primed() {
    const deps = makeDeps();
    deps.tokens.rows.set(7, token(7));
    const result = await prepareMintQuote(deps, { accountId: 1, realmId: 7 });
    if (!result.ok) throw new Error('quote failed');
    const mint = result.quote.mint;
    deps.chain.tx = makeTx({ memo: result.quote.quoteId });
    deps.chain.mint = cleanParsedMint({
      mintAuthority: FOUNDER,
      metadataPointer: { authority: null, metadataAddress: mint },
    });
    return { deps, quoteId: result.quote.quoteId, mint };
  }

  it('records the mint + launch_tx_sig after full verification', async () => {
    const { deps, quoteId, mint } = await primed();
    const result = await confirmMintCreated(deps, { accountId: 1, quoteId, signature: SIG });
    expect(result).toMatchObject({ ok: true, mint });
    const row = deps.tokens.rows.get(7);
    expect(row?.mint).toBe(mint);
    expect(row?.launchTxSig).toBe(SIG);
    expect(deps.quotes.rows.size).toBe(0);
  });

  it('rejects every tampered dimension', async () => {
    const cases: Array<[string, (d: Awaited<ReturnType<typeof primed>>) => void, string]> = [
      ['unknown quote is 404', () => {}, 'quote_not_found'],
      [
        'memo mismatch',
        (d) => {
          d.deps.chain.tx = makeTx({ memo: 'other' });
        },
        'memo_mismatch',
      ],
      [
        'wrong payer',
        (d) => {
          d.deps.chain.tx = makeTx({ memo: d.quoteId, feePayer: OTHER });
        },
        'wrong_payer',
      ],
      [
        'reverted tx',
        (d) => {
          d.deps.chain.tx = makeTx({ memo: d.quoteId, err: { failed: 1 } });
        },
        'tx_failed',
      ],
      [
        'wrong decimals',
        (d) => {
          d.deps.chain.mint = cleanParsedMint({
            decimals: 6,
            mintAuthority: FOUNDER,
            metadataPointer: { authority: null, metadataAddress: d.mint },
          });
        },
        'mint_mismatch',
      ],
      [
        'freeze authority set',
        (d) => {
          d.deps.chain.mint = cleanParsedMint({
            freezeAuthority: FOUNDER,
            mintAuthority: FOUNDER,
            metadataPointer: { authority: null, metadataAddress: d.mint },
          });
        },
        'mint_mismatch',
      ],
      [
        'premined supply',
        (d) => {
          d.deps.chain.mint = cleanParsedMint({
            supplyBase: 5n,
            mintAuthority: FOUNDER,
            metadataPointer: { authority: null, metadataAddress: d.mint },
          });
        },
        'mint_mismatch',
      ],
      [
        'wrong symbol',
        (d) => {
          d.deps.chain.mint = cleanParsedMint({
            mintAuthority: FOUNDER,
            metadata: { name: 'X', symbol: 'XXX', uri: '', updateAuthority: FOUNDER },
            metadataPointer: { authority: null, metadataAddress: d.mint },
          });
        },
        'mint_mismatch',
      ],
      [
        'forbidden extension',
        (d) => {
          const clean = cleanParsedMint({
            mintAuthority: FOUNDER,
            metadataPointer: { authority: null, metadataAddress: d.mint },
          });
          d.deps.chain.mint = {
            ...clean,
            extensions: [...clean.extensions, { extension: 'permanentDelegate' }],
          };
        },
        'mint_mismatch',
      ],
      [
        'mint authority is not the founder',
        (d) => {
          d.deps.chain.mint = cleanParsedMint({
            mintAuthority: OTHER,
            metadataPointer: { authority: null, metadataAddress: d.mint },
          });
        },
        'mint_mismatch',
      ],
    ];
    for (const [name, mutate, code] of cases) {
      const d = await primed();
      mutate(d);
      const quoteId = name === 'unknown quote is 404' ? 'missing' : d.quoteId;
      const result = await confirmMintCreated(d.deps, { accountId: 1, quoteId, signature: SIG });
      expect(result, name).toMatchObject({ ok: false, error: code });
    }
  });

  it('rejects a foreign account, an expired quote, and a bad signature shape', async () => {
    const d = await primed();
    expect(
      await confirmMintCreated(d.deps, { accountId: 2, quoteId: d.quoteId, signature: SIG }),
    ).toMatchObject({ ok: false, error: 'not_your_quote' });
    expect(
      await confirmMintCreated(d.deps, { accountId: 1, quoteId: d.quoteId, signature: 'l1O0' }),
    ).toMatchObject({ ok: false, error: 'bad_signature' });
    const stored = d.deps.quotes.rows.get(d.quoteId);
    if (stored) stored.expiresAt = new Date(Date.now() - 1000);
    expect(
      await confirmMintCreated(d.deps, { accountId: 1, quoteId: d.quoteId, signature: SIG }),
    ).toMatchObject({ ok: false, error: 'quote_expired' });
  });

  it('rejects a replayed launch signature across realms', async () => {
    const d = await primed();
    // Another realm already recorded SIG as its launch signature.
    d.deps.tokens.rows.set(9, token(9, { mint: OTHER, launchTxSig: SIG }));
    expect(
      await confirmMintCreated(d.deps, { accountId: 1, quoteId: d.quoteId, signature: SIG }),
    ).toMatchObject({ ok: false, error: 'launch_sig_reused' });
  });
});

// ── Step 2: distribution ──────────────────────────────────────────────────────

const SUPPLY = tokenSupplyBase();
const ALLOC = computeAllocation(SUPPLY, DEFAULT_ALLOCATION_BPS);

describe('distribution quote + confirm', () => {
  async function primed() {
    const deps = makeDeps();
    deps.tokens.rows.set(7, token(7, { mint: MINT, launchTxSig: SIG2 }));
    const result = await prepareDistributionQuote(deps, { accountId: 1, realmId: 7 });
    if (!result.ok) throw new Error(`quote failed: ${result.error}`);
    const curve = ALLOC.publicCurveBase + ALLOC.liquidityBase;
    const locked = ALLOC.founderBase + ALLOC.levyBase + ALLOC.treasuryBase;
    deps.chain.tx = makeTx({
      memo: result.quote.quoteId,
      post: [t22Row(ESCROW_WALLET, curve.toString()), t22Row(FOUNDER, locked.toString())],
    });
    deps.chain.mint = cleanParsedMint({
      mintAuthority: null,
      supplyBase: SUPPLY,
      metadata: { name: 'MOON', symbol: 'MOON', uri: '', updateAuthority: null },
    });
    return { deps, quoteId: result.quote.quoteId };
  }

  it('requires a mint and a presale escrow, and refuses a second distribution', async () => {
    const deps = makeDeps();
    deps.tokens.rows.set(7, token(7));
    expect(await prepareDistributionQuote(deps, { accountId: 1, realmId: 7 })).toMatchObject({
      ok: false,
      error: 'token_not_minted',
    });
    deps.tokens.rows.set(7, token(7, { mint: MINT, distributeTxSig: SIG }));
    expect(await prepareDistributionQuote(deps, { accountId: 1, realmId: 7 })).toMatchObject({
      ok: false,
      error: 'already_distributed',
    });
  });

  it('records the pinned amounts after exact delta + renounce verification', async () => {
    const { deps, quoteId } = await primed();
    const result = await confirmDistribution(deps, { accountId: 1, quoteId, signature: SIG });
    expect(result).toMatchObject({ ok: true });
    const row = deps.tokens.rows.get(7);
    expect(row?.distributeTxSig).toBe(SIG);
    expect(row?.supplyBase).toBe(SUPPLY);
    expect(row?.founderAllocBase).toBe(ALLOC.founderBase);
    expect(row?.levyAllocBase).toBe(ALLOC.levyBase);
    expect(row?.treasuryAllocBase).toBe(ALLOC.treasuryBase);
  });

  it('rejects a short bucket, an unrenounced mint, and a supply mismatch', async () => {
    {
      const { deps, quoteId } = await primed();
      deps.chain.tx = makeTx({
        memo: quoteId,
        post: [
          t22Row(ESCROW_WALLET, (ALLOC.publicCurveBase + ALLOC.liquidityBase - 1n).toString()),
          t22Row(FOUNDER, (ALLOC.founderBase + ALLOC.levyBase + ALLOC.treasuryBase).toString()),
        ],
      });
      expect(
        await confirmDistribution(deps, { accountId: 1, quoteId, signature: SIG }),
      ).toMatchObject({ ok: false, error: 'distribution_mismatch' });
    }
    {
      const { deps, quoteId } = await primed();
      deps.chain.mint = cleanParsedMint({
        mintAuthority: FOUNDER, // NOT renounced
        supplyBase: SUPPLY,
        metadata: { name: 'MOON', symbol: 'MOON', uri: '', updateAuthority: null },
      });
      expect(
        await confirmDistribution(deps, { accountId: 1, quoteId, signature: SIG }),
      ).toMatchObject({ ok: false, error: 'distribution_mismatch' });
    }
    {
      const { deps, quoteId } = await primed();
      deps.chain.mint = cleanParsedMint({
        mintAuthority: null,
        supplyBase: SUPPLY + 1n, // extra supply minted outside the quote
        metadata: { name: 'MOON', symbol: 'MOON', uri: '', updateAuthority: null },
      });
      expect(
        await confirmDistribution(deps, { accountId: 1, quoteId, signature: SIG }),
      ).toMatchObject({ ok: false, error: 'distribution_mismatch' });
    }
  });

  it('rejects an unexpected extra recipient', async () => {
    const { deps, quoteId } = await primed();
    const tx = deps.chain.tx as RawConfirmedTransaction;
    tx.meta?.postTokenBalances?.push(t22Row(OTHER, '1'));
    expect(
      await confirmDistribution(deps, { accountId: 1, quoteId, signature: SIG }),
    ).toMatchObject({ ok: false, error: 'distribution_mismatch' });
  });
});

// ── Step 3: locks ─────────────────────────────────────────────────────────────

function distributedToken(over: Partial<RealmToken> = {}): RealmToken {
  return token(7, {
    mint: MINT,
    launchTxSig: SIG2,
    distributeTxSig: SIG,
    supplyBase: SUPPLY,
    founderAllocBase: ALLOC.founderBase,
    levyAllocBase: ALLOC.levyBase,
    treasuryAllocBase: ALLOC.treasuryBase,
    ...over,
  });
}

describe('lock quote + confirm', () => {
  it('validates the bucket and the launch state', async () => {
    const deps = makeDeps();
    deps.tokens.rows.set(7, distributedToken());
    expect(await prepareLockQuote(deps, { accountId: 1, realmId: 7, bucket: 'lp' })).toMatchObject({
      ok: false,
      error: 'invalid_lock_bucket',
    });
    deps.tokens.rows.set(7, token(7, { mint: MINT }));
    expect(
      await prepareLockQuote(deps, { accountId: 1, realmId: 7, bucket: 'founder' }),
    ).toMatchObject({ ok: false, error: 'not_distributed' });
    deps.tokens.rows.set(7, distributedToken({ founderLockAddress: OTHER }));
    expect(
      await prepareLockQuote(deps, { accountId: 1, realmId: 7, bucket: 'founder' }),
    ).toMatchObject({ ok: false, error: 'already_locked' });
  });

  it('pins the levy lock to the platform wallet and the founder lock to the founder', async () => {
    const deps = makeDeps();
    deps.tokens.rows.set(7, distributedToken());
    const levy = await prepareLockQuote(deps, { accountId: 1, realmId: 7, bucket: 'levy' });
    expect(levy.ok).toBe(true);
    if (!levy.ok) return;
    const levyPayload = deps.quotes.rows.get(levy.quote.quoteId)?.payload as Record<string, string>;
    expect(levyPayload.recipient).toBe(LEVY_WALLET);
    expect(levyPayload.amountBase).toBe(ALLOC.levyBase.toString());
    expect(levyPayload.numberOfPeriod).toBe('48'); // the strictest schedule
    const founder = await prepareLockQuote(deps, { accountId: 1, realmId: 7, bucket: 'founder' });
    expect(founder.ok).toBe(true);
    if (!founder.ok) return;
    const founderPayload = deps.quotes.rows.get(founder.quote.quoteId)?.payload as Record<
      string,
      string
    >;
    expect(founderPayload.recipient).toBe(FOUNDER);
    expect(founderPayload.numberOfPeriod).toBe('36');
  });

  async function primedLock(bucket: 'founder' | 'levy' | 'treasury') {
    const deps = makeDeps();
    deps.tokens.rows.set(7, distributedToken());
    const result = await prepareLockQuote(deps, { accountId: 1, realmId: 7, bucket });
    if (!result.ok) throw new Error(`lock quote failed: ${result.error}`);
    const p = deps.quotes.rows.get(result.quote.quoteId)?.payload as Record<string, string>;
    deps.chain.accountData = escrowBuffer({
      recipient: p.recipient,
      tokenMint: MINT,
      cliffTime: BigInt(p.cliffTime),
      frequency: BigInt(p.frequency),
      cliffUnlockAmount: BigInt(p.cliffUnlockAmount),
      amountPerPeriod: BigInt(p.amountPerPeriod),
      numberOfPeriod: BigInt(p.numberOfPeriod),
      vestingStartTime: BigInt(p.vestingStartTime),
    });
    deps.chain.tokenBalance = BigInt(p.amountBase);
    return { deps, quoteId: result.quote.quoteId, escrow: result.quote.escrow };
  }

  it('records each verified lock address exactly once', async () => {
    const { deps, quoteId, escrow } = await primedLock('levy');
    const result = await confirmLock(deps, { accountId: 1, quoteId });
    expect(result).toMatchObject({ ok: true, bucket: 'levy', escrow });
    expect(deps.tokens.rows.get(7)?.levyLockAddress).toBe(escrow);
  });

  it('rejects a mutable escrow, an underfunded escrow, and a missing account', async () => {
    {
      const { deps, quoteId } = await primedLock('founder');
      const data = deps.chain.accountData as Uint8Array;
      data[138] = 1; // cancelMode: OnlyCreator (the rug vector)
      expect(await confirmLock(deps, { accountId: 1, quoteId })).toMatchObject({
        ok: false,
        error: 'lock_not_immutable',
      });
    }
    {
      const { deps, quoteId } = await primedLock('founder');
      deps.chain.tokenBalance = 1n;
      expect(await confirmLock(deps, { accountId: 1, quoteId })).toMatchObject({
        ok: false,
        error: 'lock_underfunded',
      });
    }
    {
      const { deps, quoteId } = await primedLock('founder');
      deps.chain.accountData = null;
      expect(await confirmLock(deps, { accountId: 1, quoteId })).toMatchObject({
        ok: false,
        error: 'not_finalized',
      });
    }
  });
});

// ── Listing gate + status ─────────────────────────────────────────────────────

describe('markTokenLive', () => {
  it('stays blocked until founder + levy + LP locks are all recorded', async () => {
    const deps = makeDeps();
    deps.tokens.rows.set(7, distributedToken({ founderLockAddress: 'F', levyLockAddress: 'L' }));
    expect(await markTokenLive(deps, 7)).toMatchObject({ ok: false, error: 'locks_incomplete' });
    deps.tokens.rows.set(
      7,
      distributedToken({ founderLockAddress: 'F', levyLockAddress: 'L', lpLockAddress: 'LP' }),
    );
    expect(await markTokenLive(deps, 7)).toMatchObject({ ok: true, status: 'live' });
    // Only from 'funded': a second flip has nothing to match.
    expect(await markTokenLive(deps, 7)).toMatchObject({ ok: false, error: 'mint_not_ready' });
  });
});

describe('launchStatus', () => {
  it('reports the launch checklist bucket by bucket', async () => {
    const deps = makeDeps();
    deps.tokens.rows.set(7, distributedToken({ founderLockAddress: 'F' }));
    const result = await launchStatus(deps, 7);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.launch.mint).toBe(MINT);
    expect(result.launch.supplyBase).toBe(SUPPLY.toString());
    expect(result.launch.locks.founder.address).toBe('F');
    expect(result.launch.locks.levy.address).toBeNull();
    expect(result.launch.locks.levy.allocBase).toBe(ALLOC.levyBase.toString());
    expect(result.launch.canList).toBe(false);
    expect(result.launch.levyWalletConfigured).toBe(true);
  });
});

// ── Non-custodial pin ─────────────────────────────────────────────────────────

describe('non-custodial bright line', () => {
  it('the mint factory never touches secret key material beyond transient signing', () => {
    const src = readFileSync(join(__dirname, '..', 'server', 'realm_token_mint.ts'), 'utf8');
    // The transient keypairs may partialSign; nothing may read, store, print,
    // or transmit a secret key, and no keypair is ever loaded from disk/env.
    for (const needle of ['secretKey', 'fromSecretKey', 'fromSeed', 'readFile', 'writeFile']) {
      expect(src.includes(needle), `realm_token_mint.ts must not contain ${needle}`).toBe(false);
    }
    // And the lock builder module holds no signing capability at all.
    const lockSrc = readFileSync(join(__dirname, '..', 'server', 'jup_lock.ts'), 'utf8');
    for (const needle of ['Keypair', 'secretKey', 'sign(']) {
      expect(lockSrc.includes(needle), `jup_lock.ts must not contain ${needle}`).toBe(false);
    }
  });

  it('quote payloads serialize to plain pinned facts (no 64-byte arrays)', async () => {
    const deps = makeDeps();
    deps.tokens.rows.set(7, distributedToken());
    await prepareLockQuote(deps, { accountId: 1, realmId: 7, bucket: 'founder' });
    for (const q of deps.quotes.rows.values()) {
      const json = JSON.stringify(q.payload);
      expect(json.includes('secret')).toBe(false);
      // A serialized Uint8Array secret would appear as a long numeric array.
      expect(/\[(\s*\d+\s*,){32,}/.test(json)).toBe(false);
    }
  });
});
