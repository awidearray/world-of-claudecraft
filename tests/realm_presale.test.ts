// Launchpad phase 2 (presale, asset-only + non-custodial): the single-leg
// contribution verifier (SOL native / USDC + $WOC SPL rails) against synthetic
// finalized-tx fixtures, the exact per-rail cap math at its boundaries, the
// combined soft-cap progress, the confirm flow's ledger-first UNIQUE(tx_sig)
// replay guard against an in-memory store fake, the escrow-signed refund path,
// and a source-level assertion that NO server signing exists anywhere on the
// presale path (the non-custodial bright line).

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../server/solana_rpc', async (importActual) => {
  const actual = await importActual<typeof import('../server/solana_rpc')>();
  return { ...actual, fetchFinalizedTransaction: vi.fn() };
});

import {
  checkContributionCaps,
  configurePresale,
  confirmPresaleContribution,
  confirmPresaleRefund,
  finalizePresale,
  type PresaleConfig,
  type PresaleContribution,
  type PresaleCurrency,
  type PresaleDeps,
  type PresaleQuoteRow,
  type PresaleRailCaps,
  preparePresaleQuote,
  presaleInfo,
  presaleProgress,
  type RealmPresaleStore,
  verifyPresaleContribution,
  verifyPresaleRefund,
} from '../server/realm_presale';
import type {
  MonetizationPolicy,
  RealmToken,
  RealmTokenDb,
  RealmTokenStatus,
} from '../server/realm_token';
import { fetchFinalizedTransaction, type RawConfirmedTransaction } from '../server/solana_rpc';
import { USDC_MINT, WOC_MINT } from '../server/woc_config';

const CONTRIBUTOR = 'Contrib1111111111111111111111111111111111111';
// Must be a REAL base58 32-byte address: configurePresale validates it.
const ESCROW = 'So11111111111111111111111111111111111111112';
const OTHER = 'Other11111111111111111111111111111111111111';
const SIG = '5'.repeat(80);
const SIG2 = '6'.repeat(80);
const REFUND_SIG = '7'.repeat(80);
const MEMO = 'quote-abc';

const mocked = vi.mocked(fetchFinalizedTransaction);
beforeEach(() => mocked.mockReset());

// ── Fixtures ─────────────────────────────────────────────────────────────────

function nativeTx(opts: {
  keys?: string[];
  pre: number[];
  post: number[];
  memo?: string | null;
  err?: unknown;
}): RawConfirmedTransaction {
  const instructions: Array<{ program?: string; parsed?: unknown }> = [];
  if (opts.memo !== null) instructions.push({ program: 'spl-memo', parsed: opts.memo ?? MEMO });
  return {
    meta: { err: opts.err ?? null, preBalances: opts.pre, postBalances: opts.post },
    transaction: { message: { accountKeys: opts.keys ?? [CONTRIBUTOR, ESCROW], instructions } },
  };
}

function splTx(opts: {
  mint: string;
  payer?: string;
  recipient?: string;
  recipientPost?: string;
  memo?: string | null;
  programId?: string;
  err?: unknown;
}): RawConfirmedTransaction {
  const programId = opts.programId ?? 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
  const recipient = opts.recipient ?? ESCROW;
  const payer = opts.payer ?? CONTRIBUTOR;
  const row = (owner: string, amount: string) => ({
    owner,
    mint: opts.mint,
    programId,
    uiTokenAmount: { amount },
  });
  const instructions: Array<{ program?: string; parsed?: unknown }> = [];
  if (opts.memo !== null) instructions.push({ program: 'spl-memo', parsed: opts.memo ?? MEMO });
  return {
    meta: {
      err: opts.err ?? null,
      preTokenBalances: [row(payer, '100000000'), row(recipient, '0')],
      postTokenBalances: [row(payer, '99000000'), row(recipient, opts.recipientPost ?? '1000000')],
    },
    transaction: { message: { accountKeys: [payer, recipient], instructions } },
  };
}

// ── In-memory fakes ──────────────────────────────────────────────────────────

class UniqueViolation extends Error {}
const isFakeUnique = (err: unknown): boolean => err instanceof UniqueViolation;

function token(realmId: number, status: RealmTokenStatus): RealmToken {
  return {
    realmId,
    mint: null,
    decimals: 9,
    symbol: 'MOON',
    icon: '',
    status,
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
    const row = token(t.realmId, 'prelaunch');
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
  // Launch writes (phase 3) are not exercised by this suite; a call here is a
  // wiring bug, so fail loudly rather than fake success.
  async recordMintCreated(): Promise<RealmToken | null> {
    throw new Error('recordMintCreated is not exercised by this suite');
  }
  async recordDistribution(): Promise<RealmToken | null> {
    throw new Error('recordDistribution is not exercised by this suite');
  }
  async recordLockAddress(): Promise<RealmToken | null> {
    throw new Error('recordLockAddress is not exercised by this suite');
  }
  async recordCurveLaunch(): Promise<RealmToken | null> {
    throw new Error('recordCurveLaunch is not exercised by this suite');
  }
  async recordLpLock(): Promise<RealmToken | null> {
    throw new Error('recordLpLock is not exercised by this suite');
  }
  async listByStatus(): Promise<Array<RealmToken & { realmName: string }>> {
    throw new Error('listByStatus is not exercised by this suite');
  }
}

class FakeStore implements RealmPresaleStore {
  presales = new Map<number, PresaleConfig>();
  quotes = new Map<string, PresaleQuoteRow>();
  contributions: PresaleContribution[] = [];
  private nextId = 1;
  async createPresale(config: {
    realmId: number;
    escrowWallet: string;
    rails: Partial<Record<PresaleCurrency, PresaleRailCaps>>;
  }) {
    if (this.presales.has(config.realmId)) throw new UniqueViolation('dup presale');
    this.presales.set(config.realmId, { ...config, createdAt: new Date() });
  }
  async getPresale(realmId: number) {
    return this.presales.get(realmId) ?? null;
  }
  async createQuote(q: PresaleQuoteRow) {
    this.quotes.set(q.quoteId, q);
  }
  async getQuote(quoteId: string) {
    return this.quotes.get(quoteId) ?? null;
  }
  async deleteQuote(quoteId: string) {
    this.quotes.delete(quoteId);
  }
  async raisedByCurrency(realmId: number) {
    const out = new Map<PresaleCurrency, bigint>();
    for (const c of this.contributions) {
      if (c.realmId !== realmId) continue;
      out.set(c.currency, (out.get(c.currency) ?? 0n) + c.amountBase);
    }
    return out;
  }
  async contributedByWallet(realmId: number, wallet: string, currency: PresaleCurrency) {
    let total = 0n;
    for (const c of this.contributions) {
      if (c.realmId === realmId && c.wallet === wallet && c.currency === currency)
        total += c.amountBase;
    }
    return total;
  }
  async insertContribution(c: {
    realmId: number;
    accountId: number;
    wallet: string;
    currency: PresaleCurrency;
    amountBase: bigint;
    payTxSig: string;
  }) {
    if (this.contributions.some((x) => x.payTxSig === c.payTxSig))
      throw new UniqueViolation('dup tx sig');
    this.contributions.push({
      ...c,
      contributionId: this.nextId++,
      refundTxSig: null,
      refundedAt: null,
      createdAt: new Date(),
    });
  }
  async getContributionByPaySig(payTxSig: string) {
    return this.contributions.find((c) => c.payTxSig === payTxSig) ?? null;
  }
  async listContributionsForWallet(realmId: number, wallet: string) {
    return this.contributions.filter((c) => c.realmId === realmId && c.wallet === wallet);
  }
  async markRefunded(contributionId: number, refundTxSig: string) {
    if (this.contributions.some((c) => c.refundTxSig === refundTxSig))
      throw new UniqueViolation('dup refund sig');
    const row = this.contributions.find((c) => c.contributionId === contributionId);
    if (!row || row.refundTxSig !== null) return false;
    row.refundTxSig = refundTxSig;
    row.refundedAt = new Date();
    return true;
  }
  async countUnrefunded(realmId: number) {
    return this.contributions.filter((c) => c.realmId === realmId && c.refundTxSig === null).length;
  }
  async withPresaleLock<T>(
    _realmId: number,
    fn: (locked: RealmPresaleStore) => Promise<T>,
  ): Promise<T> {
    return fn(this);
  }
}

const CAPS: PresaleRailCaps = {
  softCapBase: 1_000_000n,
  raiseCapBase: 2_000_000n,
  walletCapBase: 1_500_000n,
};

function makeDeps(
  over: {
    status?: RealmTokenStatus;
    configured?: boolean;
    wallets?: Record<number, string | null>;
  } = {},
) {
  const tokens = new FakeTokens();
  tokens.rows.set(7, token(7, over.status ?? 'presale'));
  const store = new FakeStore();
  if (over.configured !== false) {
    store.presales.set(7, {
      realmId: 7,
      escrowWallet: ESCROW,
      rails: { SOL: { ...CAPS }, USDC: { ...CAPS }, WOC: { ...CAPS } },
      createdAt: new Date(),
    });
  }
  const wallets = over.wallets ?? {};
  const deps: PresaleDeps = {
    tokens,
    store,
    walletForAccount: async (accountId) => {
      const w = accountId in wallets ? wallets[accountId] : CONTRIBUTOR;
      return w ? { pubkey: w } : null;
    },
    rolesForAccountOnRealm: async (_realmId, accountId) => (accountId === 1 ? ['owner'] : []),
    isUniqueViolation: isFakeUnique,
  };
  return { deps, tokens, store };
}

// A recorded quote + matching on-chain fixture, for confirm-flow tests.
async function quoteFor(deps: PresaleDeps, amount: string, accountId = 2, currency = 'SOL') {
  const r = await preparePresaleQuote(deps, {
    accountId,
    realmId: 7,
    currency,
    amountBase: amount,
  });
  expect(r.ok).toBe(true);
  if (!r.ok) throw new Error('quote failed');
  return r.quote;
}

function fundedSolTx(amount: number, memo: string) {
  return nativeTx({ pre: [10_000_000, 0], post: [10_000_000 - amount, amount], memo });
}

// ── Pure cap math: exact at the boundaries ───────────────────────────────────

describe('checkContributionCaps', () => {
  it('accepts exactly at the wallet cap and rejects one base unit over', () => {
    const at = checkContributionCaps({
      caps: CAPS,
      raisedBase: 0n,
      walletContributedBase: 500_000n,
      amountBase: 1_000_000n,
    });
    expect(at).toEqual({ ok: true });
    const over = checkContributionCaps({
      caps: CAPS,
      raisedBase: 0n,
      walletContributedBase: 500_000n,
      amountBase: 1_000_001n,
    });
    expect(over).toEqual({ ok: false, reason: 'wallet_cap_exceeded' });
  });

  it('accepts exactly at the total-raise cap and rejects one base unit over', () => {
    const at = checkContributionCaps({
      caps: CAPS,
      raisedBase: 1_500_000n,
      walletContributedBase: 0n,
      amountBase: 500_000n,
    });
    expect(at).toEqual({ ok: true });
    const over = checkContributionCaps({
      caps: CAPS,
      raisedBase: 1_500_000n,
      walletContributedBase: 0n,
      amountBase: 500_001n,
    });
    expect(over).toEqual({ ok: false, reason: 'raise_cap_exceeded' });
  });
});

describe('presaleProgress (combined soft cap, no pricing)', () => {
  it('sums exact per-rail fractions', () => {
    // 50% of SOL target + 50% of USDC target = combined soft cap met.
    const met = presaleProgress([
      { raisedBase: 500_000n, softCapBase: 1_000_000n },
      { raisedBase: 1_000n, softCapBase: 2_000n },
    ]);
    expect(met).toEqual({ progressBps: 10_000, softCapMet: true });
    const short = presaleProgress([
      { raisedBase: 500_000n, softCapBase: 1_000_000n },
      { raisedBase: 999n, softCapBase: 2_000n },
    ]);
    expect(short.softCapMet).toBe(false);
    expect(short.progressBps).toBe(9995); // 5000 + 4995
  });

  it('caps the display at 10000 bps and handles no rails', () => {
    expect(presaleProgress([{ raisedBase: 3_000_000n, softCapBase: 1_000_000n }]).progressBps).toBe(
      10_000,
    );
    expect(presaleProgress([])).toEqual({ progressBps: 0, softCapMet: false });
  });
});

// ── Contribution verifier ────────────────────────────────────────────────────

const verifyArgs = {
  paySig: SIG,
  wallet: CONTRIBUTOR,
  currency: 'SOL' as PresaleCurrency,
  escrow: ESCROW,
  amountBase: 1_000_000n,
  memo: MEMO,
};

describe('verifyPresaleContribution (SOL)', () => {
  it('accepts a finalized transfer crediting the escrow', async () => {
    mocked.mockResolvedValue(fundedSolTx(1_000_000, MEMO));
    expect(await verifyPresaleContribution(verifyArgs)).toEqual({ ok: true });
  });

  it('rejects a wrong (short) amount', async () => {
    mocked.mockResolvedValue(fundedSolTx(999_999, MEMO));
    expect(await verifyPresaleContribution(verifyArgs)).toEqual({
      ok: false,
      reason: 'escrow_short',
    });
  });

  it('rejects a wrong recipient (funds landed elsewhere)', async () => {
    mocked.mockResolvedValue(
      nativeTx({ keys: [CONTRIBUTOR, OTHER], pre: [10_000_000, 0], post: [9_000_000, 1_000_000] }),
    );
    expect(await verifyPresaleContribution(verifyArgs)).toEqual({
      ok: false,
      reason: 'escrow_short',
    });
  });

  it('binds the payer to the quoted linked wallet', async () => {
    mocked.mockResolvedValue(
      nativeTx({ keys: [OTHER, ESCROW], pre: [10_000_000, 0], post: [9_000_000, 1_000_000] }),
    );
    expect(await verifyPresaleContribution(verifyArgs)).toEqual({
      ok: false,
      reason: 'wrong_payer',
    });
  });

  it('rejects a wrong / missing memo, a reverted tx, and an unfinalized sig', async () => {
    mocked.mockResolvedValue(fundedSolTx(1_000_000, 'other-quote'));
    expect(await verifyPresaleContribution(verifyArgs)).toEqual({
      ok: false,
      reason: 'memo_mismatch',
    });
    mocked.mockResolvedValue(nativeTx({ pre: [1, 0], post: [0, 0], err: { x: 1 } }));
    expect(await verifyPresaleContribution(verifyArgs)).toEqual({ ok: false, reason: 'tx_failed' });
    mocked.mockResolvedValue(null);
    expect(await verifyPresaleContribution(verifyArgs)).toEqual({
      ok: false,
      reason: 'not_finalized',
    });
  });

  it('rejects a malformed signature before touching the chain', async () => {
    expect(await verifyPresaleContribution({ ...verifyArgs, paySig: 'nope!' })).toEqual({
      ok: false,
      reason: 'bad_signature',
    });
    expect(mocked).not.toHaveBeenCalled();
  });
});

describe('verifyPresaleContribution (USDC + $WOC SPL rails)', () => {
  it('accepts a USDC transfer and a $WOC transfer to the escrow', async () => {
    mocked.mockResolvedValue(splTx({ mint: USDC_MINT }));
    expect(await verifyPresaleContribution({ ...verifyArgs, currency: 'USDC' })).toEqual({
      ok: true,
    });
    mocked.mockResolvedValue(splTx({ mint: WOC_MINT }));
    expect(await verifyPresaleContribution({ ...verifyArgs, currency: 'WOC' })).toEqual({
      ok: true,
    });
  });

  it('rejects a Token-2022 look-alike on the SPL rails (gate NOT loosened)', async () => {
    mocked.mockResolvedValue(
      splTx({ mint: USDC_MINT, programId: 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb' }),
    );
    expect(await verifyPresaleContribution({ ...verifyArgs, currency: 'USDC' })).toEqual({
      ok: false,
      reason: 'token_2022',
    });
  });

  it('rejects a short SPL amount and a wrong SPL recipient', async () => {
    mocked.mockResolvedValue(splTx({ mint: USDC_MINT, recipientPost: '999999' }));
    expect(await verifyPresaleContribution({ ...verifyArgs, currency: 'USDC' })).toEqual({
      ok: false,
      reason: 'escrow_short',
    });
    mocked.mockResolvedValue(splTx({ mint: USDC_MINT, recipient: OTHER }));
    expect(await verifyPresaleContribution({ ...verifyArgs, currency: 'USDC' })).toEqual({
      ok: false,
      reason: 'escrow_short',
    });
  });
});

// ── Configure + quote ────────────────────────────────────────────────────────

describe('configurePresale', () => {
  it('is owner-only, presale-status-only, once-only, and validates caps', async () => {
    const { deps } = makeDeps({ configured: false });
    const rails = { SOL: { softCapBase: '1000', raiseCapBase: '2000', walletCapBase: '500' } };
    expect(
      await configurePresale(deps, { accountId: 2, realmId: 7, escrowWallet: ESCROW, rails }),
    ).toMatchObject({ ok: false, status: 403, error: 'not_realm_owner' });
    expect(
      await configurePresale(deps, {
        accountId: 1,
        realmId: 7,
        escrowWallet: 'not-an-address',
        rails,
      }),
    ).toMatchObject({ ok: false, error: 'invalid_escrow_wallet' });
    expect(
      await configurePresale(deps, { accountId: 1, realmId: 7, escrowWallet: ESCROW, rails: {} }),
    ).toMatchObject({ ok: false, error: 'invalid_presale_caps' });
    // Raise cap under the soft cap is malformed.
    expect(
      await configurePresale(deps, {
        accountId: 1,
        realmId: 7,
        escrowWallet: ESCROW,
        rails: { SOL: { softCapBase: '2000', raiseCapBase: '1000', walletCapBase: '500' } },
      }),
    ).toMatchObject({ ok: false, error: 'invalid_presale_caps' });
    const ok = await configurePresale(deps, {
      accountId: 1,
      realmId: 7,
      escrowWallet: ESCROW,
      rails,
    });
    expect(ok.ok).toBe(true);
    expect(
      await configurePresale(deps, { accountId: 1, realmId: 7, escrowWallet: ESCROW, rails }),
    ).toMatchObject({ ok: false, status: 409, error: 'presale_already_configured' });
  });
});

describe('preparePresaleQuote', () => {
  it('pins a quote with memo == quoteId against the founder escrow', async () => {
    const { deps } = makeDeps();
    const quote = await quoteFor(deps, '1000000');
    expect(quote.memo).toBe(quote.quoteId);
    expect(quote.escrowWallet).toBe(ESCROW);
    expect(quote.native).toBe(true);
    expect(quote.amountBase).toBe('1000000');
  });

  it('rejects an unlinked wallet with the typed error (locked identity rule)', async () => {
    const { deps } = makeDeps({ wallets: { 2: null } });
    expect(
      await preparePresaleQuote(deps, {
        accountId: 2,
        realmId: 7,
        currency: 'SOL',
        amountBase: '1',
      }),
    ).toMatchObject({ ok: false, status: 400, error: 'wallet_not_linked' });
  });

  it('rejects closed presales, missing config, bad rails, and bad amounts', async () => {
    expect(
      await preparePresaleQuote(makeDeps({ status: 'voting' }).deps, {
        accountId: 2,
        realmId: 7,
        currency: 'SOL',
        amountBase: '1',
      }),
    ).toMatchObject({ ok: false, error: 'presale_not_open' });
    expect(
      await preparePresaleQuote(makeDeps({ configured: false }).deps, {
        accountId: 2,
        realmId: 7,
        currency: 'SOL',
        amountBase: '1',
      }),
    ).toMatchObject({ ok: false, error: 'presale_not_configured' });
    expect(
      await preparePresaleQuote(makeDeps().deps, {
        accountId: 2,
        realmId: 7,
        currency: 'DOGE',
        amountBase: '1',
      }),
    ).toMatchObject({ ok: false, error: 'invalid_currency' });
    expect(
      await preparePresaleQuote(makeDeps().deps, {
        accountId: 2,
        realmId: 7,
        currency: 'SOL',
        amountBase: '0',
      }),
    ).toMatchObject({ ok: false, error: 'invalid_amount' });
    expect(
      await preparePresaleQuote(makeDeps().deps, {
        accountId: 2,
        realmId: 7,
        currency: 'SOL',
        amountBase: '1.5',
      }),
    ).toMatchObject({ ok: false, error: 'invalid_amount' });
  });

  it('prechecks the caps with typed errors', async () => {
    const { deps } = makeDeps();
    expect(
      await preparePresaleQuote(deps, {
        accountId: 2,
        realmId: 7,
        currency: 'SOL',
        amountBase: '1500001',
      }),
    ).toMatchObject({ ok: false, status: 409, error: 'wallet_cap_exceeded' });
  });
});

// ── Confirm: ledger-first, replay-guarded, caps exact at the boundary ────────

describe('confirmPresaleContribution', () => {
  it('records a verified contribution ledger-first and consumes the quote', async () => {
    const { deps, store } = makeDeps();
    const quote = await quoteFor(deps, '1000000');
    mocked.mockResolvedValue(fundedSolTx(1_000_000, quote.quoteId));
    const r = await confirmPresaleContribution(deps, {
      accountId: 2,
      quoteId: quote.quoteId,
      paySig: SIG,
    });
    expect(r).toMatchObject({ ok: true, contributionRecorded: true });
    expect(store.contributions).toHaveLength(1);
    expect(store.contributions[0]).toMatchObject({
      payTxSig: SIG,
      amountBase: 1_000_000n,
      wallet: CONTRIBUTOR,
    });
    expect(store.quotes.size).toBe(0);
  });

  it('rejects a replayed signature (UNIQUE tx_sig) and consumes the quote', async () => {
    const { deps, store } = makeDeps();
    const q1 = await quoteFor(deps, '100000');
    mocked.mockResolvedValue(fundedSolTx(100_000, q1.quoteId));
    expect(
      (await confirmPresaleContribution(deps, { accountId: 2, quoteId: q1.quoteId, paySig: SIG }))
        .ok,
    ).toBe(true);
    // A second quote redeemed with the SAME on-chain payment must not double-count.
    const q2 = await quoteFor(deps, '100000');
    mocked.mockResolvedValue(fundedSolTx(100_000, q2.quoteId));
    expect(
      await confirmPresaleContribution(deps, { accountId: 2, quoteId: q2.quoteId, paySig: SIG }),
    ).toMatchObject({ ok: false, status: 409, error: 'contribution_already_recorded' });
    expect(store.contributions).toHaveLength(1);
    expect(store.quotes.has(q2.quoteId)).toBe(false); // consumed, not retryable
  });

  it('accepts a contribution exactly at the wallet cap and rejects one base unit over at confirm', async () => {
    const { deps, store } = makeDeps();
    // Fill to 500k, then confirm exactly to the 1.5M wallet cap.
    const q1 = await quoteFor(deps, '500000');
    mocked.mockResolvedValue(fundedSolTx(500_000, q1.quoteId));
    expect(
      (await confirmPresaleContribution(deps, { accountId: 2, quoteId: q1.quoteId, paySig: SIG }))
        .ok,
    ).toBe(true);
    const q2 = await quoteFor(deps, '1000000');
    // Another confirmed contribution slips in between quote and confirm, pushing
    // the wallet one unit past its cap: the exact recheck under the lock rejects.
    store.contributions.push({
      contributionId: 99,
      realmId: 7,
      accountId: 2,
      wallet: CONTRIBUTOR,
      currency: 'SOL',
      amountBase: 1n,
      payTxSig: 'RACER',
      refundTxSig: null,
      refundedAt: null,
      createdAt: new Date(),
    });
    mocked.mockResolvedValue(fundedSolTx(1_000_000, q2.quoteId));
    expect(
      await confirmPresaleContribution(deps, { accountId: 2, quoteId: q2.quoteId, paySig: SIG2 }),
    ).toMatchObject({ ok: false, status: 409, error: 'wallet_cap_exceeded' });
    // Remove the racer: the same confirm now lands exactly at the cap.
    store.contributions = store.contributions.filter((c) => c.payTxSig !== 'RACER');
    expect(
      (await confirmPresaleContribution(deps, { accountId: 2, quoteId: q2.quoteId, paySig: SIG2 }))
        .ok,
    ).toBe(true);
    expect(await store.contributedByWallet(7, CONTRIBUTOR, 'SOL')).toBe(1_500_000n);
  });

  it('rejects on-chain shortfalls with the verifier verdict', async () => {
    const { deps } = makeDeps();
    const quote = await quoteFor(deps, '1000000');
    mocked.mockResolvedValue(fundedSolTx(999_999, quote.quoteId));
    expect(
      await confirmPresaleContribution(deps, { accountId: 2, quoteId: quote.quoteId, paySig: SIG }),
    ).toMatchObject({ ok: false, status: 400, error: 'escrow_short' });
  });

  it('guards quote ownership, expiry, and a presale closed after quoting', async () => {
    const { deps, store, tokens } = makeDeps();
    const quote = await quoteFor(deps, '1000');
    expect(
      await confirmPresaleContribution(deps, { accountId: 3, quoteId: quote.quoteId, paySig: SIG }),
    ).toMatchObject({ ok: false, status: 403, error: 'not_your_quote' });
    const stored = store.quotes.get(quote.quoteId);
    expect(stored).toBeDefined();
    if (!stored) return;
    stored.expiresAt = new Date(Date.now() - 1000);
    expect(
      await confirmPresaleContribution(deps, { accountId: 2, quoteId: quote.quoteId, paySig: SIG }),
    ).toMatchObject({ ok: false, status: 410, error: 'quote_expired' });
    stored.expiresAt = new Date(Date.now() + 60_000);
    tokens.rows.set(7, token(7, 'refunding'));
    expect(
      await confirmPresaleContribution(deps, { accountId: 2, quoteId: quote.quoteId, paySig: SIG }),
    ).toMatchObject({ ok: false, status: 409, error: 'presale_not_open' });
  });
});

// ── Finalize + refund path ───────────────────────────────────────────────────

async function contribute(deps: PresaleDeps, amount: string, sig: string, accountId = 2) {
  const quote = await quoteFor(deps, amount, accountId);
  mocked.mockResolvedValue(fundedSolTx(Number(amount), quote.quoteId));
  const r = await confirmPresaleContribution(deps, {
    accountId,
    quoteId: quote.quoteId,
    paySig: sig,
  });
  expect(r.ok).toBe(true);
}

describe('finalizePresale', () => {
  it('flips presale -> funded when the combined soft cap is met', async () => {
    const { deps, tokens, store } = makeDeps();
    await contribute(deps, '600000', SIG);
    // 600k/1M SOL + 400k/1M USDC = exactly the combined soft cap.
    store.contributions.push({
      contributionId: 98,
      realmId: 7,
      accountId: 3,
      wallet: OTHER,
      currency: 'USDC',
      amountBase: 400_000n,
      payTxSig: SIG2,
      refundTxSig: null,
      refundedAt: null,
      createdAt: new Date(),
    });
    const r = await finalizePresale(deps, { accountId: 1, realmId: 7 });
    expect(r).toMatchObject({ ok: true, status: 'funded' });
    expect(tokens.rows.get(7)!.status).toBe('funded');
  });

  it('flips presale -> refunding on a missed soft cap, owner-only, once', async () => {
    const { deps, tokens } = makeDeps();
    await contribute(deps, '100000', SIG);
    expect(await finalizePresale(deps, { accountId: 2, realmId: 7 })).toMatchObject({
      ok: false,
      status: 403,
      error: 'not_realm_owner',
    });
    expect(await finalizePresale(deps, { accountId: 1, realmId: 7 })).toMatchObject({
      ok: true,
      status: 'refunding',
    });
    expect(tokens.rows.get(7)!.status).toBe('refunding');
    expect(await finalizePresale(deps, { accountId: 1, realmId: 7 })).toMatchObject({
      ok: false,
      error: 'presale_not_open',
    });
  });
});

describe('confirmPresaleRefund (server verifies, never pays)', () => {
  async function refundingDeps() {
    const made = makeDeps();
    await contribute(made.deps, '100000', SIG);
    await finalizePresale(made.deps, { accountId: 1, realmId: 7 });
    expect(made.tokens.rows.get(7)!.status).toBe('refunding');
    return made;
  }
  // A refund: the ESCROW wallet pays the contributor back, memo = the original
  // contribution signature (one refund tx binds to exactly one contribution).
  function refundTx(amount: number, memo: string, payer = ESCROW, recipient = CONTRIBUTOR) {
    return nativeTx({
      keys: [payer, recipient],
      pre: [10_000_000, 0],
      post: [10_000_000 - amount, amount],
      memo,
    });
  }

  it('verifies an escrow-signed refund and flips refunding -> refunded when all rows are covered', async () => {
    const { deps, tokens, store } = await refundingDeps();
    mocked.mockResolvedValue(refundTx(100_000, SIG));
    const r = await confirmPresaleRefund(deps, {
      realmId: 7,
      payTxSig: SIG,
      refundSig: REFUND_SIG,
    });
    expect(r).toMatchObject({ ok: true, refunded: true, unrefundedCount: 0 });
    expect(store.contributions[0].refundTxSig).toBe(REFUND_SIG);
    expect(tokens.rows.get(7)!.status).toBe('refunded');
  });

  it('rejects a refund not signed (fee-paid) by the escrow wallet', async () => {
    const { deps } = await refundingDeps();
    mocked.mockResolvedValue(refundTx(100_000, SIG, OTHER));
    expect(
      await confirmPresaleRefund(deps, { realmId: 7, payTxSig: SIG, refundSig: REFUND_SIG }),
    ).toMatchObject({ ok: false, error: 'wrong_refunder' });
  });

  it('rejects a short refund, a wrong recipient, and a wrong memo binding', async () => {
    const { deps } = await refundingDeps();
    mocked.mockResolvedValue(refundTx(99_999, SIG));
    expect(
      await confirmPresaleRefund(deps, { realmId: 7, payTxSig: SIG, refundSig: REFUND_SIG }),
    ).toMatchObject({ ok: false, error: 'refund_short' });
    mocked.mockResolvedValue(refundTx(100_000, SIG, ESCROW, OTHER));
    expect(
      await confirmPresaleRefund(deps, { realmId: 7, payTxSig: SIG, refundSig: REFUND_SIG }),
    ).toMatchObject({ ok: false, error: 'refund_short' });
    mocked.mockResolvedValue(refundTx(100_000, 'not-the-contribution-sig'));
    expect(
      await confirmPresaleRefund(deps, { realmId: 7, payTxSig: SIG, refundSig: REFUND_SIG }),
    ).toMatchObject({ ok: false, error: 'memo_mismatch' });
  });

  it('rejects double refunds and reusing one refund tx across contributions', async () => {
    const { deps, store } = await refundingDeps();
    // A second (unrefunded) contribution exists, so the token stays refunding.
    store.contributions.push({
      contributionId: 97,
      realmId: 7,
      accountId: 3,
      wallet: OTHER,
      currency: 'SOL',
      amountBase: 100_000n,
      payTxSig: SIG2,
      refundTxSig: null,
      refundedAt: null,
      createdAt: new Date(),
    });
    mocked.mockResolvedValue(refundTx(100_000, SIG));
    expect(
      (await confirmPresaleRefund(deps, { realmId: 7, payTxSig: SIG, refundSig: REFUND_SIG })).ok,
    ).toBe(true);
    expect(
      await confirmPresaleRefund(deps, { realmId: 7, payTxSig: SIG, refundSig: REFUND_SIG }),
    ).toMatchObject({ ok: false, error: 'already_refunded' });
    // The other contribution cannot ride the same refund transaction.
    mocked.mockResolvedValue(
      nativeTx({
        keys: [ESCROW, OTHER],
        pre: [1_000_000, 0],
        post: [900_000, 100_000],
        memo: SIG2,
      }),
    );
    expect(
      await confirmPresaleRefund(deps, { realmId: 7, payTxSig: SIG2, refundSig: REFUND_SIG }),
    ).toMatchObject({ ok: false, error: 'refund_sig_reused' });
  });

  it('only runs while refunding/refunded', async () => {
    const { deps } = makeDeps();
    await contribute(deps, '100000', SIG);
    expect(
      await confirmPresaleRefund(deps, { realmId: 7, payTxSig: SIG, refundSig: REFUND_SIG }),
    ).toMatchObject({ ok: false, error: 'presale_not_refunding' });
  });
});

// ── Panel read ───────────────────────────────────────────────────────────────

describe('presaleInfo', () => {
  it('reports per-rail progress, per-wallet remaining, and the refund counter', async () => {
    const { deps, tokens } = makeDeps();
    await contribute(deps, '400000', SIG);
    const r = await presaleInfo(deps, { realmId: 7, accountId: 2 });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const sol = r.presale.rails.find((x) => x.currency === 'SOL')!;
    expect(sol).toMatchObject({
      raisedBase: '400000',
      myContributedBase: '400000',
      myRemainingBase: '1100000',
    });
    // Combined-fraction semantics: 400k of the 1M SOL component = 4000 bps of
    // the combined target (fully funding ANY one rail's soft component meets it).
    expect(r.presale.progressBps).toBe(4000);
    expect(r.presale.softCapMet).toBe(false);
    expect(r.presale.refund).toBeNull();
    tokens.rows.set(7, token(7, 'refunding'));
    const refunding = await presaleInfo(deps, { realmId: 7, accountId: 2 });
    expect(refunding.ok && refunding.presale.refund).toEqual({ unrefundedCount: 1 });
  });
});

// ── Non-custodial: NO server signing anywhere on the presale path ────────────

describe('non-custodial invariant (source scan)', () => {
  it('the presale path contains no keypair, signing, or secret-key material', () => {
    const FORBIDDEN = [
      /Keypair/,
      /secretKey/i,
      /partialSign/,
      /signTransaction/i,
      /signAndSend/i,
      /sendTransaction/i,
      /PRIVATE_KEY/i,
      /SETTLE.*KEY/i,
      /SOLANA_DEVNET_DEPLOYER/,
      /fromSecret/i,
      /nacl\.sign/,
    ];
    for (const file of ['server/realm_presale.ts', 'server/realm_presale_db.ts']) {
      const src = readFileSync(join(process.cwd(), file), 'utf8');
      for (const re of FORBIDDEN) {
        expect(re.test(src), `${file} must not match ${re}`).toBe(false);
      }
    }
  });
});
