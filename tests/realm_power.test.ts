// Launchpad phase 7 (server/realm_power.ts): power-realm token-to-copper
// credits against in-memory fakes. THE phase acceptance is the
// monetization_policy gate: a `cosmetic` realm (the default, and always the
// canonical realm) can never convert, checked on EVERY quote AND confirm. The
// rest pins the two config knobs (both deliberately set or the surface stays
// dark), the exact floor conversion math, the scoped Token-2022 verification
// of the finalized transfer (memo/payer/sink), and the ledger-first replay
// guard on pay_tx_sig.

import { describe, expect, it } from 'vitest';
import {
  confirmPowerCredit,
  copperCreditFor,
  copperPerWholeToken,
  type PowerDeps,
  type PowerQuoteRow,
  powerCreditEnabled,
  preparePowerQuote,
  type RealmPowerStore,
} from '../server/realm_power';
import type { MonetizationPolicy, RealmToken, RealmTokenStatus } from '../server/realm_token';
import type { RealmTokenLaunch } from '../server/realm_token_mint';
import type { RawConfirmedTransaction } from '../server/solana_rpc';
import { SPL_TOKEN_2022_PROGRAM, SPL_TOKEN_PROGRAM } from '../server/solana_rpc';

// ── Fixture identities ───────────────────────────────────────────────────────

const REALM_ID = 5;
const ACCOUNT_ID = 7;
const CHARACTER_ID = 31;
const WALLET = 'PlayerWallet1111111111111111111111111111111';
const OTHER_WALLET = 'OtherWallet22222222222222222222222222222222';
const MINT = 'MoonMint1111111111111111111111111111111111';
const TREASURY = 'TreasurySink3333333333333333333333333333333';
const PAY_SIG = '5'.repeat(64);

const TOKEN_BASE = 10n ** 9n;

// ── Fakes ────────────────────────────────────────────────────────────────────

class UniqueViolation extends Error {}

function tokenRow(over: Partial<RealmToken> = {}): RealmToken {
  return {
    realmId: REALM_ID,
    mint: MINT,
    decimals: 9,
    symbol: 'MOON',
    icon: '',
    status: 'live' as RealmTokenStatus,
    monetizationPolicy: 'power' as MonetizationPolicy,
    curveAddress: 'curve-1',
    poolAddress: null,
    lpLockAddress: null,
    feeClaimerPda: null,
    launchTxSig: 'sig-1',
    createdAt: new Date('2026-07-01T00:00:00Z'),
    updatedAt: new Date('2026-07-01T00:00:00Z'),
    ...over,
  };
}

function launchRow(): RealmTokenLaunch {
  return {
    realmId: REALM_ID,
    pendingMint: MINT,
    supplyBase: 1_000_000_000n * TOKEN_BASE,
    alloc: { founderBps: 1200, levyBps: 800, treasuryBps: 1000, liquidityBps: 1000 },
    founderWallet: WALLET,
    levyWallet: OTHER_WALLET,
    treasuryWallet: TREASURY,
    founderLockAddress: null,
    levyLockAddress: null,
    treasuryLockAddress: null,
    mintConfirmedAt: new Date('2026-07-02T00:00:00Z'),
    locksVerifiedAt: new Date('2026-07-03T00:00:00Z'),
    createdAt: new Date('2026-07-01T00:00:00Z'),
    updatedAt: new Date('2026-07-03T00:00:00Z'),
  };
}

class FakePowerStore implements RealmPowerStore {
  quotes = new Map<string, PowerQuoteRow>();
  credits: Array<{
    realmId: number;
    accountId: number;
    characterId: number;
    wallet: string;
    amountBase: bigint;
    copperCredit: bigint;
    payTxSig: string;
  }> = [];
  private sigs = new Set<string>();
  async createQuote(q: PowerQuoteRow): Promise<void> {
    this.quotes.set(q.quoteId, q);
  }
  async getQuote(quoteId: string): Promise<PowerQuoteRow | null> {
    return this.quotes.get(quoteId) ?? null;
  }
  async deleteQuote(quoteId: string): Promise<void> {
    this.quotes.delete(quoteId);
  }
  async insertCredit(c: (typeof this.credits)[number]): Promise<void> {
    if (this.sigs.has(c.payTxSig)) throw new UniqueViolation('duplicate pay_tx_sig');
    this.sigs.add(c.payTxSig);
    this.credits.push(c);
  }
}

// The finalized payment: one Token-2022 transfer of `amount` into the sink,
// memo-bound to the quote. Overrides model each verifier failure.
function paymentTx(
  memo: string,
  over: {
    err?: unknown;
    payer?: string;
    sinkDelta?: bigint;
    programId?: string;
  } = {},
): RawConfirmedTransaction {
  const payer = over.payer ?? WALLET;
  const sinkDelta = over.sinkDelta ?? 3n * TOKEN_BASE;
  const programId = over.programId ?? SPL_TOKEN_2022_PROGRAM;
  return {
    meta: {
      err: over.err ?? null,
      preTokenBalances: [
        { owner: payer, mint: MINT, programId, uiTokenAmount: { amount: sinkDelta.toString() } },
      ],
      postTokenBalances: [
        { owner: payer, mint: MINT, programId, uiTokenAmount: { amount: '0' } },
        {
          owner: TREASURY,
          mint: MINT,
          programId,
          uiTokenAmount: { amount: sinkDelta.toString() },
        },
      ],
    },
    transaction: {
      message: {
        accountKeys: [{ pubkey: payer }, { pubkey: TREASURY }],
        instructions: [{ program: 'spl-memo', parsed: memo }],
      },
    },
  };
}

interface FakeWorld {
  deps: PowerDeps;
  store: FakePowerStore;
  tokens: Map<number, RealmToken>;
  txs: Map<string, RawConfirmedTransaction>;
}

function makeWorld(over: {
  env?: Record<string, string | undefined>;
  token?: RealmToken | null;
  launch?: RealmTokenLaunch | null;
  linkedWallet?: string | null;
}): FakeWorld {
  const store = new FakePowerStore();
  const tokens = new Map<number, RealmToken>();
  const token = over.token === undefined ? tokenRow() : over.token;
  if (token) tokens.set(token.realmId, token);
  const launch = over.launch === undefined ? launchRow() : over.launch;
  const txs = new Map<string, RawConfirmedTransaction>();
  const linked = over.linkedWallet === undefined ? WALLET : over.linkedWallet;
  const deps = {
    tokens: {
      getRealmToken: async (realmId: number) => tokens.get(realmId) ?? null,
    },
    launches: {
      getLaunch: async (realmId: number) => (realmId === REALM_ID ? launch : null),
    },
    store,
    walletForAccount: async (accountId: number) =>
      accountId === ACCOUNT_ID && linked ? { pubkey: linked } : null,
    ownsCharacter: async (accountId: number, characterId: number) =>
      accountId === ACCOUNT_ID && characterId === CHARACTER_ID,
    fetchTx: async (sig: string) => txs.get(sig) ?? null,
    isUniqueViolation: (err: unknown) => err instanceof UniqueViolation,
    env: {
      REALM_POWER_CREDIT_ENABLED: '1',
      REALM_POWER_COPPER_PER_TOKEN: '100',
      ...over.env,
    },
  } as unknown as PowerDeps;
  return { deps, store, tokens, txs };
}

async function quoteOk(world: FakeWorld, amountBase = (3n * TOKEN_BASE).toString()) {
  const res = await preparePowerQuote(world.deps, {
    accountId: ACCOUNT_ID,
    realmId: REALM_ID,
    characterId: CHARACTER_ID,
    amountBase,
  });
  if (!res.ok) throw new Error(`quote failed: ${res.error}`);
  return res.quote;
}

// ── Config knobs ─────────────────────────────────────────────────────────────

describe('power credit config gates', () => {
  it('powerCreditEnabled requires the exact flag value 1', () => {
    expect(powerCreditEnabled({})).toBe(false);
    expect(powerCreditEnabled({ REALM_POWER_CREDIT_ENABLED: '0' })).toBe(false);
    expect(powerCreditEnabled({ REALM_POWER_CREDIT_ENABLED: 'true' })).toBe(false);
    expect(powerCreditEnabled({ REALM_POWER_CREDIT_ENABLED: '1' })).toBe(true);
    expect(powerCreditEnabled({ REALM_POWER_CREDIT_ENABLED: ' 1 ' })).toBe(true);
  });

  it('copperPerWholeToken defaults to 0 and rejects non-strict integers', () => {
    expect(copperPerWholeToken({})).toBe(0n);
    expect(copperPerWholeToken({ REALM_POWER_COPPER_PER_TOKEN: '10.5' })).toBe(0n);
    expect(copperPerWholeToken({ REALM_POWER_COPPER_PER_TOKEN: '-5' })).toBe(0n);
    expect(copperPerWholeToken({ REALM_POWER_COPPER_PER_TOKEN: 'abc' })).toBe(0n);
    expect(copperPerWholeToken({ REALM_POWER_COPPER_PER_TOKEN: '1'.repeat(13) })).toBe(0n);
    expect(copperPerWholeToken({ REALM_POWER_COPPER_PER_TOKEN: '250' })).toBe(250n);
  });

  it('copperCreditFor floors exactly at 9 decimals', () => {
    // 1.5 tokens at 100 copper/token = 150 copper, exact.
    expect(copperCreditFor(1_500_000_000n, 100n)).toBe(150n);
    // 0.019 tokens at 100 copper/token = 1.9 -> floors to 1.
    expect(copperCreditFor(19_000_000n, 100n)).toBe(1n);
    // Dust below one copper floors to zero (rejected upstream as below-minimum).
    expect(copperCreditFor(1n, 100n)).toBe(0n);
    expect(copperCreditFor(0n, 100n)).toBe(0n);
    expect(copperCreditFor(-5n, 100n)).toBe(0n);
    expect(copperCreditFor(TOKEN_BASE, 0n)).toBe(0n);
  });
});

// ── Quote gates ──────────────────────────────────────────────────────────────

describe('preparePowerQuote gates', () => {
  const args = {
    accountId: ACCOUNT_ID,
    realmId: REALM_ID,
    characterId: CHARACTER_ID,
    amountBase: (3n * TOKEN_BASE).toString(),
  };

  it('stays dark platform-wide without the flag', async () => {
    const world = makeWorld({ env: { REALM_POWER_CREDIT_ENABLED: undefined } });
    const res = await preparePowerQuote(world.deps, args);
    expect(res).toMatchObject({ ok: false, status: 503, error: 'power_disabled' });
  });

  it('THE policy gate: a cosmetic realm can never convert', async () => {
    const world = makeWorld({ token: tokenRow({ monetizationPolicy: 'cosmetic' }) });
    const res = await preparePowerQuote(world.deps, args);
    expect(res).toMatchObject({ ok: false, status: 403, error: 'realm_not_power' });
  });

  it('rejects an unregistered token', async () => {
    const world = makeWorld({ token: null });
    const res = await preparePowerQuote(world.deps, args);
    expect(res).toMatchObject({ ok: false, status: 404, error: 'token_not_registered' });
  });

  it('requires a live or graduated token', async () => {
    const world = makeWorld({ token: tokenRow({ status: 'presale' }) });
    const res = await preparePowerQuote(world.deps, args);
    expect(res).toMatchObject({ ok: false, status: 409, error: 'token_not_live' });
    const graduated = makeWorld({ token: tokenRow({ status: 'graduated' }) });
    expect((await preparePowerQuote(graduated.deps, args)).ok).toBe(true);
  });

  it('requires the mint to exist', async () => {
    const world = makeWorld({ token: tokenRow({ mint: null }) });
    const res = await preparePowerQuote(world.deps, args);
    expect(res).toMatchObject({ ok: false, status: 409, error: 'mint_not_created' });
  });

  it('stays dark until a rate is deliberately configured', async () => {
    const world = makeWorld({ env: { REALM_POWER_COPPER_PER_TOKEN: undefined } });
    const res = await preparePowerQuote(world.deps, args);
    expect(res).toMatchObject({ ok: false, status: 503, error: 'power_rate_unset' });
  });

  it('requires the launch row for the treasury sink', async () => {
    const world = makeWorld({ launch: null });
    const res = await preparePowerQuote(world.deps, args);
    expect(res).toMatchObject({ ok: false, status: 503, error: 'power_sink_unavailable' });
  });

  it('rejects malformed and below-minimum amounts', async () => {
    const world = makeWorld({});
    expect(await preparePowerQuote(world.deps, { ...args, amountBase: '1.5' })).toMatchObject({
      ok: false,
      status: 400,
      error: 'invalid_amount',
    });
    expect(await preparePowerQuote(world.deps, { ...args, amountBase: '-3' })).toMatchObject({
      ok: false,
      status: 400,
      error: 'invalid_amount',
    });
    // 1 base unit converts to 0 copper at any sane rate: below minimum.
    expect(await preparePowerQuote(world.deps, { ...args, amountBase: '1' })).toMatchObject({
      ok: false,
      status: 400,
      error: 'amount_below_minimum',
    });
  });

  it('requires a linked wallet and character ownership', async () => {
    const noWallet = makeWorld({ linkedWallet: null });
    expect(await preparePowerQuote(noWallet.deps, args)).toMatchObject({
      ok: false,
      status: 400,
      error: 'wallet_not_linked',
    });
    const world = makeWorld({});
    expect(await preparePowerQuote(world.deps, { ...args, characterId: 999 })).toMatchObject({
      ok: false,
      status: 404,
      error: 'character_not_found',
    });
  });

  it('pins the copper credit, sink, and memo in the persisted quote', async () => {
    const world = makeWorld({});
    const quote = await quoteOk(world);
    expect(quote.mint).toBe(MINT);
    expect(quote.amountBase).toBe((3n * TOKEN_BASE).toString());
    expect(quote.copperCredit).toBe('300'); // 3 whole tokens at 100 copper/token
    expect(quote.sinkWallet).toBe(TREASURY);
    expect(quote.memo).toBe(quote.quoteId);
    const stored = world.store.quotes.get(quote.quoteId);
    expect(stored).toBeDefined();
    expect(stored?.characterId).toBe(CHARACTER_ID);
    expect(stored?.wallet).toBe(WALLET);
    expect(stored?.copperCredit).toBe(300n);
    // Default TTL is 10 minutes.
    const ttlMs = new Date(quote.expiresAt).getTime() - Date.now();
    expect(ttlMs).toBeGreaterThan(9 * 60_000);
    expect(ttlMs).toBeLessThanOrEqual(10 * 60_000);
  });
});

// ── Confirm ──────────────────────────────────────────────────────────────────

describe('confirmPowerCredit', () => {
  it('rejects unknown, foreign, and expired quotes', async () => {
    const world = makeWorld({});
    expect(
      await confirmPowerCredit(world.deps, {
        accountId: ACCOUNT_ID,
        quoteId: 'missing',
        paySig: PAY_SIG,
      }),
    ).toMatchObject({ ok: false, status: 404, error: 'quote_not_found' });

    const quote = await quoteOk(world);
    expect(
      await confirmPowerCredit(world.deps, {
        accountId: ACCOUNT_ID + 1,
        quoteId: quote.quoteId,
        paySig: PAY_SIG,
      }),
    ).toMatchObject({ ok: false, status: 403, error: 'not_your_quote' });

    const stored = world.store.quotes.get(quote.quoteId);
    if (!stored) throw new Error('quote not stored');
    world.store.quotes.set(quote.quoteId, {
      ...stored,
      expiresAt: new Date(Date.now() - 1000),
    });
    expect(
      await confirmPowerCredit(world.deps, {
        accountId: ACCOUNT_ID,
        quoteId: quote.quoteId,
        paySig: PAY_SIG,
      }),
    ).toMatchObject({ ok: false, status: 410, error: 'quote_expired' });
  });

  it('re-checks the policy gate on confirm (quote is not a bypass)', async () => {
    const world = makeWorld({});
    const quote = await quoteOk(world);
    // The realm flips to cosmetic between quote and confirm: conversion dies.
    world.tokens.set(REALM_ID, tokenRow({ monetizationPolicy: 'cosmetic' }));
    world.txs.set(PAY_SIG, paymentTx(quote.quoteId));
    expect(
      await confirmPowerCredit(world.deps, {
        accountId: ACCOUNT_ID,
        quoteId: quote.quoteId,
        paySig: PAY_SIG,
      }),
    ).toMatchObject({ ok: false, status: 403, error: 'realm_not_power' });
  });

  it('verifies the finalized transfer: signature, finality, success, memo, payer, sink', async () => {
    const world = makeWorld({});
    const quote = await quoteOk(world);
    const confirm = (paySig: string) =>
      confirmPowerCredit(world.deps, { accountId: ACCOUNT_ID, quoteId: quote.quoteId, paySig });

    expect(await confirm('not base58!')).toMatchObject({ status: 400, error: 'bad_signature' });
    expect(await confirm(PAY_SIG)).toMatchObject({ status: 400, error: 'not_finalized' });

    world.txs.set(PAY_SIG, paymentTx(quote.quoteId, { err: { code: 1 } }));
    expect(await confirm(PAY_SIG)).toMatchObject({ status: 400, error: 'tx_failed' });

    world.txs.set(PAY_SIG, paymentTx('some-other-quote'));
    expect(await confirm(PAY_SIG)).toMatchObject({ status: 400, error: 'memo_mismatch' });

    world.txs.set(PAY_SIG, paymentTx(quote.quoteId, { payer: OTHER_WALLET }));
    expect(await confirm(PAY_SIG)).toMatchObject({ status: 400, error: 'wrong_payer' });

    world.txs.set(PAY_SIG, paymentTx(quote.quoteId, { sinkDelta: 3n * TOKEN_BASE - 1n }));
    expect(await confirm(PAY_SIG)).toMatchObject({ status: 400, error: 'sink_short' });

    // A legacy-program transfer of the same mint never counts (scoped parser).
    world.txs.set(PAY_SIG, paymentTx(quote.quoteId, { programId: SPL_TOKEN_PROGRAM }));
    expect(await confirm(PAY_SIG)).toMatchObject({ status: 400, error: 'sink_short' });
  });

  it('credits ledger-first, deletes the quote, and reports the character to poke', async () => {
    const world = makeWorld({});
    const quote = await quoteOk(world);
    world.txs.set(PAY_SIG, paymentTx(quote.quoteId));
    const res = await confirmPowerCredit(world.deps, {
      accountId: ACCOUNT_ID,
      quoteId: quote.quoteId,
      paySig: PAY_SIG,
    });
    expect(res).toMatchObject({ ok: true, characterId: CHARACTER_ID, copperCredit: '300' });
    expect(world.store.credits).toEqual([
      {
        realmId: REALM_ID,
        accountId: ACCOUNT_ID,
        characterId: CHARACTER_ID,
        wallet: WALLET,
        amountBase: 3n * TOKEN_BASE,
        copperCredit: 300n,
        payTxSig: PAY_SIG,
      },
    ]);
    expect(world.store.quotes.has(quote.quoteId)).toBe(false);
  });

  it('a replayed pay signature dies on the ledger UNIQUE and burns the quote', async () => {
    const world = makeWorld({});
    const first = await quoteOk(world);
    world.txs.set(PAY_SIG, paymentTx(first.quoteId));
    expect(
      (
        await confirmPowerCredit(world.deps, {
          accountId: ACCOUNT_ID,
          quoteId: first.quoteId,
          paySig: PAY_SIG,
        })
      ).ok,
    ).toBe(true);

    // A second quote redeemed with the SAME transaction signature.
    const second = await quoteOk(world);
    world.txs.set(PAY_SIG, paymentTx(second.quoteId));
    expect(
      await confirmPowerCredit(world.deps, {
        accountId: ACCOUNT_ID,
        quoteId: second.quoteId,
        paySig: PAY_SIG,
      }),
    ).toMatchObject({ ok: false, status: 409, error: 'credit_already_recorded' });
    expect(world.store.credits).toHaveLength(1);
    expect(world.store.quotes.has(second.quoteId)).toBe(false);
  });
});
