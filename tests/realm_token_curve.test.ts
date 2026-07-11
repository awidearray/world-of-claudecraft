// Launchpad phase 4 (bonding-curve launch behind the LaunchVenue seam): the
// pure launch plan (allocation -> curve knobs, the off-curve PDA fee-claimer
// gate), the live-config verifier against every tampered dimension, the
// Meteora config mapping (buildCurve output normalized and re-verified), the
// stub venue, and the full quote/confirm/reconcile/leftover orchestration over
// in-memory fakes, ending with the phase-3 lock flow taking over the levy +
// treasury buckets and the listing gate opening exactly once every proof is
// on-chain.

import type { PoolConfig } from '@meteora-ag/dynamic-bonding-curve-sdk';
import { Keypair, PublicKey } from '@solana/web3.js';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MODE_IMMUTABLE, VESTING_ESCROW_DISC, VESTING_ESCROW_SIZE } from '../server/jup_lock';
import {
  type CurveConfigFacts,
  curveFeeClaimer,
  curveLaunchPlan,
  curveProgressBps,
  StubLaunchVenue,
  verifyCurveConfigFacts,
  WSOL_MINT,
} from '../server/realm_launchpad';
import {
  dbcConfigParameters,
  dbcLockerEscrow,
  normalizeDbcConfig,
} from '../server/realm_launchpad_dbc';
import type {
  MonetizationPolicy,
  RealmToken,
  RealmTokenDb,
  RealmTokenStatus,
} from '../server/realm_token';
import {
  computeAllocation,
  DEFAULT_ALLOCATION_BPS,
  tokenSupplyBase,
} from '../server/realm_token_alloc';
import {
  type CurveDeps,
  confirmCurveLaunch,
  confirmLeftover,
  curveState,
  prepareCurveQuote,
  prepareLeftoverQuote,
  reconcileCurve,
} from '../server/realm_token_curve';
import type { LaunchChain, LaunchQuoteRow, LaunchQuoteStore } from '../server/realm_token_mint';
import { prepareLockQuote } from '../server/realm_token_mint';
import type { RawConfirmedTransaction } from '../server/solana_rpc';
import type { ParsedMintInfo } from '../server/solana_token2022';
import { TOKEN_2022_PROGRAM } from '../server/solana_token2022';

const FOUNDER = Keypair.fromSeed(new Uint8Array(32).fill(1)).publicKey.toBase58();
const OTHER = Keypair.fromSeed(new Uint8Array(32).fill(5)).publicKey.toBase58();
const LEVY_WALLET = Keypair.fromSeed(new Uint8Array(32).fill(3)).publicKey.toBase58();
// A genuine off-curve address (a PDA): the only shape the fee claimer accepts.
const FEE_CLAIMER_PDA = PublicKey.findProgramAddressSync(
  [Buffer.from('fee_vault')],
  new PublicKey('LocpQgucEQHbqNABEYvBvwoxCPsSbG91A1QaQhQQqjn'),
)[0].toBase58();
const SIG = '5'.repeat(80);

const SUPPLY = tokenSupplyBase();
const ALLOC = computeAllocation(SUPPLY, DEFAULT_ALLOCATION_BPS);

beforeEach(() => {
  process.env.REALM_LAUNCHPAD_FEE_CLAIMER = FEE_CLAIMER_PDA;
  process.env.REALM_TOKEN_LEVY_WALLET = LEVY_WALLET;
});
afterEach(() => {
  delete process.env.REALM_LAUNCHPAD_FEE_CLAIMER;
  delete process.env.REALM_TOKEN_LEVY_WALLET;
  delete process.env.REALM_CURVE_QUOTE;
});

// ── The pure plan + fee-claimer gate ──────────────────────────────────────────

describe('curveFeeClaimer (PDA, never an EOA)', () => {
  it('accepts only a well-formed OFF-CURVE address', () => {
    expect(curveFeeClaimer()).toBe(FEE_CLAIMER_PDA);
    process.env.REALM_LAUNCHPAD_FEE_CLAIMER = FOUNDER; // an on-curve wallet
    expect(curveFeeClaimer()).toBeNull();
    process.env.REALM_LAUNCHPAD_FEE_CLAIMER = 'not-an-address';
    expect(curveFeeClaimer()).toBeNull();
    delete process.env.REALM_LAUNCHPAD_FEE_CLAIMER;
    expect(curveFeeClaimer()).toBeNull();
  });
});

describe('curveLaunchPlan', () => {
  it('maps the phase-3 allocation onto the curve knobs exactly', () => {
    const plan = curveLaunchPlan(FOUNDER);
    expect(plan).not.toBeNull();
    if (!plan) return;
    expect(plan.quote).toBe('SOL');
    expect(plan.quoteMint).toBe(WSOL_MINT);
    expect(plan.supplyBase).toBe(SUPPLY);
    expect(plan.founderAllocBase).toBe(ALLOC.founderBase);
    expect(plan.levyAllocBase).toBe(ALLOC.levyBase);
    expect(plan.treasuryAllocBase).toBe(ALLOC.treasuryBase);
    expect(BigInt(plan.leftoverTokens) * 10n ** 9n).toBe(ALLOC.levyBase + ALLOC.treasuryBase);
    expect(BigInt(plan.founderVestingTokens) * 10n ** 9n).toBe(ALLOC.founderBase);
    expect(plan.liquidityPercent).toBe(DEFAULT_ALLOCATION_BPS.liquidity / 100);
    expect(plan.vesting.numberOfPeriod).toBe(36);
    expect(plan.vesting.cliffFromMigrationSec).toBe(12 * 30 * 86_400);
    expect(plan.feeClaimer).toBe(FEE_CLAIMER_PDA);
    expect(plan.leftoverReceiver).toBe(FOUNDER);
  });

  it('fails closed without an off-curve fee claimer', () => {
    delete process.env.REALM_LAUNCHPAD_FEE_CLAIMER;
    expect(curveLaunchPlan(FOUNDER)).toBeNull();
  });

  it('supports the USDC quote rail', () => {
    process.env.REALM_CURVE_QUOTE = 'USDC';
    const plan = curveLaunchPlan(FOUNDER);
    expect(plan?.quote).toBe('USDC');
    expect(plan?.quoteDecimals).toBe(6);
  });
});

describe('curveProgressBps', () => {
  it('is exact and display-capped', () => {
    expect(curveProgressBps(0n, 100n)).toBe(0);
    expect(curveProgressBps(40n, 100n)).toBe(4000);
    expect(curveProgressBps(100n, 100n)).toBe(10_000);
    expect(curveProgressBps(250n, 100n)).toBe(10_000);
    expect(curveProgressBps(1n, 0n)).toBe(0);
  });
});

// ── The live-config verifier ──────────────────────────────────────────────────

function factsFor(planFounder = FOUNDER): {
  facts: CurveConfigFacts;
  plan: NonNullable<ReturnType<typeof curveLaunchPlan>>;
} {
  const plan = curveLaunchPlan(planFounder);
  if (!plan) throw new Error('plan unconfigurable');
  const perPeriod = plan.founderAllocBase / BigInt(plan.vesting.numberOfPeriod);
  const facts: CurveConfigFacts = {
    quoteMint: plan.quoteMint,
    feeClaimer: plan.feeClaimer,
    leftoverReceiver: plan.leftoverReceiver,
    tokenType2022: true,
    tokenAuthorityImmutable: true,
    tokenDecimal: 9,
    migrationOptionDammV2: true,
    permanentLockedLiquidityPercent: 100,
    withdrawableLiquidityPercent: 0,
    migrationQuoteThresholdBase: 100n * 10n ** 9n,
    lockedVesting: {
      cliffUnlockBase: plan.founderAllocBase - perPeriod * BigInt(plan.vesting.numberOfPeriod),
      amountPerPeriodBase: perPeriod,
      numberOfPeriod: BigInt(plan.vesting.numberOfPeriod),
      frequencySec: BigInt(plan.vesting.frequencySec),
      cliffFromMigrationSec: BigInt(plan.vesting.cliffFromMigrationSec),
    },
  };
  return { facts, plan };
}

describe('verifyCurveConfigFacts', () => {
  it('accepts facts that carry every pinned commitment', () => {
    const { facts, plan } = factsFor();
    expect(verifyCurveConfigFacts(facts, plan)).toEqual({ ok: true });
  });

  it('rejects every tampered dimension', () => {
    const { facts, plan } = factsFor();
    const cases: Array<[string, Partial<CurveConfigFacts>]> = [
      ['wrong quote mint', { quoteMint: OTHER }],
      ['wrong fee claimer', { feeClaimer: OTHER }],
      ['wrong leftover receiver', { leftoverReceiver: OTHER }],
      ['legacy token program', { tokenType2022: false }],
      ['mutable token authority', { tokenAuthorityImmutable: false }],
      ['wrong decimals', { tokenDecimal: 6 }],
      ['DAMM v1 migration', { migrationOptionDammV2: false }],
      ['partial permanent lock', { permanentLockedLiquidityPercent: 99 }],
      ['withdrawable LP', { withdrawableLiquidityPercent: 1 }],
      ['zero threshold', { migrationQuoteThresholdBase: 0n }],
    ];
    for (const [name, over] of cases) {
      expect(verifyCurveConfigFacts({ ...facts, ...over }, plan), name).toEqual({
        ok: false,
        reason: 'curve_mismatch',
      });
    }
    // Vesting tampering: short total, wrong cadence, short cliff.
    const v = facts.lockedVesting;
    expect(
      verifyCurveConfigFacts(
        { ...facts, lockedVesting: { ...v, amountPerPeriodBase: v.amountPerPeriodBase - 1n } },
        plan,
      ),
    ).toEqual({ ok: false, reason: 'curve_mismatch' });
    expect(
      verifyCurveConfigFacts({ ...facts, lockedVesting: { ...v, frequencySec: 60n } }, plan),
    ).toEqual({ ok: false, reason: 'curve_mismatch' });
    expect(
      verifyCurveConfigFacts(
        { ...facts, lockedVesting: { ...v, cliffFromMigrationSec: 1n } },
        plan,
      ),
    ).toEqual({ ok: false, reason: 'curve_mismatch' });
  });
});

// ── The Meteora mapping, normalized and re-verified offline ──────────────────

describe('dbcConfigParameters -> normalizeDbcConfig round-trip', () => {
  it('the built config, read back as an account, passes the pinned-plan verifier', () => {
    const plan = curveLaunchPlan(FOUNDER);
    expect(plan).not.toBeNull();
    if (!plan) return;
    const params = dbcConfigParameters(plan);
    // What the chain would store: the ConfigParameters fields plus the
    // create-accounts addresses (lockedVesting is stored as
    // lockedVestingConfig on the account).
    const account = {
      ...params,
      quoteMint: new PublicKey(plan.quoteMint),
      feeClaimer: new PublicKey(plan.feeClaimer),
      leftoverReceiver: new PublicKey(plan.leftoverReceiver),
      lockedVestingConfig: params.lockedVesting,
    } as unknown as PoolConfig;
    const facts = normalizeDbcConfig(account);
    expect(facts.tokenType2022).toBe(true);
    expect(facts.tokenAuthorityImmutable).toBe(true);
    expect(facts.migrationOptionDammV2).toBe(true);
    expect(facts.permanentLockedLiquidityPercent).toBe(100);
    expect(facts.withdrawableLiquidityPercent).toBe(0);
    // The vesting total is EXACTLY the founder bucket (dust in the cliff).
    const v = facts.lockedVesting;
    expect(v.cliffUnlockBase + v.amountPerPeriodBase * v.numberOfPeriod).toBe(
      plan.founderAllocBase,
    );
    expect(verifyCurveConfigFacts(facts, plan)).toEqual({ ok: true });
  });

  it('derives the locker escrow deterministically from the pool', () => {
    const a = dbcLockerEscrow(OTHER);
    expect(a).toBe(dbcLockerEscrow(OTHER));
    expect(a).not.toBe(dbcLockerEscrow(FOUNDER));
  });
});

// ── Orchestration over the stub venue ─────────────────────────────────────────

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
    if (!row || (row.distributeTxSig === null && row.curveAddress === null)) return null;
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
    return Keypair.fromSeed(new Uint8Array(32).fill(9)).publicKey.toBase58();
  }
  async rentExemptLamports() {
    return 3_000_000;
  }
}

function chainTx(opts: {
  feePayer?: string;
  mint?: string;
  founderDelta?: bigint;
  err?: unknown;
}): RawConfirmedTransaction {
  const post =
    opts.mint && opts.founderDelta !== undefined
      ? [
          {
            owner: FOUNDER,
            mint: opts.mint,
            programId: TOKEN_2022_PROGRAM,
            uiTokenAmount: { amount: opts.founderDelta.toString() },
          },
        ]
      : [];
  return {
    meta: { err: opts.err ?? null, preTokenBalances: [], postTokenBalances: post },
    transaction: {
      message: { accountKeys: [opts.feePayer ?? FOUNDER, OTHER], instructions: [] },
    },
  };
}

function makeDeps(): CurveDeps & {
  tokens: FakeTokens;
  quotes: FakeQuotes;
  chain: FakeChain;
  venue: StubLaunchVenue;
} {
  return {
    tokens: new FakeTokens(),
    quotes: new FakeQuotes(),
    chain: new FakeChain(),
    venue: new StubLaunchVenue(),
    presales: { getPresale: async () => null },
    walletForAccount: async (accountId: number) => (accountId === 1 ? { pubkey: FOUNDER } : null),
    rolesForAccountOnRealm: async (_realmId: number, accountId: number) =>
      accountId === 1 ? ['owner'] : [],
    isUniqueViolation: isFakeUnique,
  } as CurveDeps & {
    tokens: FakeTokens;
    quotes: FakeQuotes;
    chain: FakeChain;
    venue: StubLaunchVenue;
  };
}

async function launched(deps = makeDeps()) {
  deps.tokens.rows.set(7, token(7));
  const quote = await prepareCurveQuote(deps, { accountId: 1, realmId: 7 });
  if (!quote.ok) throw new Error(`quote failed: ${quote.error}`);
  deps.chain.tx = chainTx({});
  const confirmed = await confirmCurveLaunch(deps, {
    accountId: 1,
    quoteId: quote.quote.quoteId,
    signature: SIG,
  });
  if (!confirmed.ok) throw new Error(`confirm failed: ${confirmed.error}`);
  return { deps, pool: quote.quote.poolAddress, baseMint: quote.quote.baseMint };
}

describe('prepareCurveQuote', () => {
  it('guards owner, status, prior mint, prior curve, venue, and fee claimer', async () => {
    const deps = makeDeps();
    deps.tokens.rows.set(7, token(7));
    expect(await prepareCurveQuote(deps, { accountId: 2, realmId: 7 })).toMatchObject({
      ok: false,
      error: 'not_realm_owner',
    });
    deps.tokens.rows.set(7, token(7, { status: 'presale' }));
    expect(await prepareCurveQuote(deps, { accountId: 1, realmId: 7 })).toMatchObject({
      ok: false,
      error: 'mint_not_ready',
    });
    deps.tokens.rows.set(7, token(7, { mint: OTHER }));
    expect(await prepareCurveQuote(deps, { accountId: 1, realmId: 7 })).toMatchObject({
      ok: false,
      error: 'token_already_minted',
    });
    deps.tokens.rows.set(7, token(7, { curveAddress: OTHER }));
    expect(await prepareCurveQuote(deps, { accountId: 1, realmId: 7 })).toMatchObject({
      ok: false,
      error: 'curve_already_launched',
    });
    deps.tokens.rows.set(7, token(7));
    delete process.env.REALM_LAUNCHPAD_FEE_CLAIMER;
    expect(await prepareCurveQuote(deps, { accountId: 1, realmId: 7 })).toMatchObject({
      ok: false,
      error: 'fee_claimer_unconfigured',
    });
    process.env.REALM_LAUNCHPAD_FEE_CLAIMER = FEE_CLAIMER_PDA;
    const disabled = { ...makeDeps(), venue: null } as CurveDeps;
    (disabled.tokens as FakeTokens).rows.set(7, token(7));
    expect(await prepareCurveQuote(disabled, { accountId: 1, realmId: 7 })).toMatchObject({
      ok: false,
      error: 'curve_disabled',
    });
  });

  it('pins the full plan into the quote payload', async () => {
    const deps = makeDeps();
    deps.tokens.rows.set(7, token(7));
    const result = await prepareCurveQuote(deps, { accountId: 1, realmId: 7 });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const stored = deps.quotes.rows.get(result.quote.quoteId);
    expect(stored?.kind).toBe('curve');
    const p = stored?.payload as Record<string, string>;
    expect(p.configAddress).toBe(result.quote.configAddress);
    expect(p.poolAddress).toBe(result.quote.poolAddress);
    expect(p.baseMint).toBe(result.quote.baseMint);
    expect(p.feeClaimer).toBe(FEE_CLAIMER_PDA);
    expect(p.leftoverReceiver).toBe(FOUNDER);
    expect(p.founderAllocBase).toBe(ALLOC.founderBase.toString());
    expect(JSON.stringify(stored?.payload).includes('secret')).toBe(false);
  });
});

describe('confirmCurveLaunch', () => {
  it('records the verified launch once and rejects a second confirm', async () => {
    const { deps, pool, baseMint } = await launched();
    const row = deps.tokens.rows.get(7);
    expect(row?.mint).toBe(baseMint);
    expect(row?.launchTxSig).toBe(SIG);
    expect(row?.poolAddress).toBe(pool);
    expect(row?.feeClaimerPda).toBe(FEE_CLAIMER_PDA);
    expect(row?.supplyBase).toBe(SUPPLY);
    expect(row?.founderAllocBase).toBe(ALLOC.founderBase);
    expect(row?.status).toBe('funded'); // live waits for the locks
    expect(deps.quotes.rows.size).toBe(0);
  });

  it('rejects wrong payer, reverted tx, and a live-config mismatch', async () => {
    const deps = makeDeps();
    deps.tokens.rows.set(7, token(7));
    const quote = await prepareCurveQuote(deps, { accountId: 1, realmId: 7 });
    if (!quote.ok) throw new Error('quote failed');
    deps.chain.tx = chainTx({ feePayer: OTHER });
    expect(
      await confirmCurveLaunch(deps, {
        accountId: 1,
        quoteId: quote.quote.quoteId,
        signature: SIG,
      }),
    ).toMatchObject({ ok: false, error: 'wrong_payer' });
    deps.chain.tx = chainTx({ err: { failed: 1 } });
    expect(
      await confirmCurveLaunch(deps, {
        accountId: 1,
        quoteId: quote.quote.quoteId,
        signature: SIG,
      }),
    ).toMatchObject({ ok: false, error: 'tx_failed' });
    // Tamper the pinned plan so the (plan-echoing) stub facts no longer match:
    // the on-chain config now disagrees with what was quoted.
    deps.chain.tx = chainTx({});
    const stored = deps.quotes.rows.get(quote.quote.quoteId);
    if (stored) (stored.payload as Record<string, string>).founderAllocBase = '1';
    expect(
      await confirmCurveLaunch(deps, {
        accountId: 1,
        quoteId: quote.quote.quoteId,
        signature: SIG,
      }),
    ).toMatchObject({ ok: false, error: 'curve_mismatch' });
  });
});

describe('curveState', () => {
  it('reads the live pool through the venue', async () => {
    const { deps, pool } = await launched();
    const result = await curveState(deps, 7);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.curve.poolAddress).toBe(pool);
    expect(result.curve.isMigrated).toBe(false);
    expect(result.curve.progressBps).toBe(0);
    expect(BigInt(result.curve.migrationQuoteThresholdBase)).toBeGreaterThan(0n);
  });

  it('requires a launched curve', async () => {
    const deps = makeDeps();
    deps.tokens.rows.set(7, token(7));
    expect(await curveState(deps, 7)).toMatchObject({ ok: false, error: 'curve_not_launched' });
  });
});

// A 296-byte locker escrow buffer for the reconcile step.
function lockerBuffer(args: {
  recipient: string;
  mint: string;
  totalBase: bigint;
  cancelMode?: number;
}): Uint8Array {
  const buf = Buffer.alloc(VESTING_ESCROW_SIZE);
  Buffer.from(VESTING_ESCROW_DISC).copy(buf, 0);
  new PublicKey(args.recipient).toBuffer().copy(buf, 8);
  new PublicKey(args.mint).toBuffer().copy(buf, 40);
  new PublicKey(OTHER).toBuffer().copy(buf, 72);
  new PublicKey(OTHER).toBuffer().copy(buf, 104);
  buf[137] = MODE_IMMUTABLE;
  buf[138] = args.cancelMode ?? MODE_IMMUTABLE;
  buf[139] = 1;
  const perPeriod = args.totalBase / 36n;
  buf.writeBigUInt64LE(args.totalBase - perPeriod * 36n, 160); // cliff unlock (dust)
  buf.writeBigUInt64LE(perPeriod, 168);
  buf.writeBigUInt64LE(36n, 176);
  return Uint8Array.from(buf);
}

describe('reconcileCurve', () => {
  it('walks migration -> founder lock + LP lock -> live -> graduated', async () => {
    const { deps, pool, baseMint } = await launched();
    // Not migrated yet: nothing to record, status stays funded.
    let result = await reconcileCurve(deps, { accountId: 1, realmId: 7 });
    expect(result).toMatchObject({ ok: true, status: 'funded', founderLock: null, lpLock: null });

    // Graduate the stub pool; serve a verifiable locker escrow.
    const stubPool = deps.venue.pools.get(pool);
    if (stubPool) stubPool.isMigrated = true;
    deps.chain.accountData = lockerBuffer({
      recipient: FOUNDER,
      mint: baseMint,
      totalBase: ALLOC.founderBase,
    });
    result = await reconcileCurve(deps, { accountId: 1, realmId: 7 });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.founderLock).not.toBeNull();
    expect(result.lpLock).not.toBeNull();
    // founder + LP locks exist but the levy lock does not: still not live.
    expect(result.status).toBe('funded');

    // Complete the leftover + levy lock (below covers the mechanics); here,
    // record the levy lock directly and reconcile again.
    await deps.tokens.recordDistribution(7, {
      distributeTxSig: '9'.repeat(80),
      supplyBase: SUPPLY,
      founderAllocBase: ALLOC.founderBase,
      levyAllocBase: ALLOC.levyBase,
      treasuryAllocBase: ALLOC.treasuryBase,
    });
    await deps.tokens.recordLockAddress(7, 'levy', 'LevyLock111');
    result = await reconcileCurve(deps, { accountId: 1, realmId: 7 });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.status).toBe('graduated'); // live, then graduated (migrated)
  });

  it('rejects a locker escrow that does not carry the founder bucket', async () => {
    const { deps, pool, baseMint } = await launched();
    const stubPool = deps.venue.pools.get(pool);
    if (stubPool) stubPool.isMigrated = true;
    deps.chain.accountData = lockerBuffer({
      recipient: FOUNDER,
      mint: baseMint,
      totalBase: ALLOC.founderBase - 1n,
    });
    expect(await reconcileCurve(deps, { accountId: 1, realmId: 7 })).toMatchObject({
      ok: false,
      error: 'lock_mismatch',
    });
    // A cancelable locker whose creator is an ordinary (on-curve) wallet is
    // rejected as not-immutable: only the DBC program's OFF-CURVE PDA creator,
    // which can never sign a cancel, is accepted at cancel_mode 1.
    deps.chain.accountData = lockerBuffer({
      recipient: FOUNDER,
      mint: baseMint,
      totalBase: ALLOC.founderBase,
      cancelMode: 1,
    });
    expect(await reconcileCurve(deps, { accountId: 1, realmId: 7 })).toMatchObject({
      ok: false,
      error: 'lock_not_immutable',
    });
  });
});

describe('leftover withdrawal (levy + treasury buckets)', () => {
  it('requires migration, verifies the exact founder delta, then hands off to the phase-3 locks', async () => {
    const { deps, pool, baseMint } = await launched();
    expect(await prepareLeftoverQuote(deps, { accountId: 1, realmId: 7 })).toMatchObject({
      ok: false,
      error: 'not_migrated',
    });
    const stubPool = deps.venue.pools.get(pool);
    if (stubPool) stubPool.isMigrated = true;

    const quote = await prepareLeftoverQuote(deps, { accountId: 1, realmId: 7 });
    expect(quote.ok).toBe(true);
    if (!quote.ok) return;

    // Short delta (below the reserved levy + treasury) rejected.
    deps.chain.tx = chainTx({
      mint: baseMint,
      founderDelta: ALLOC.levyBase + ALLOC.treasuryBase - 1n,
    });
    expect(
      await confirmLeftover(deps, { accountId: 1, quoteId: quote.quote.quoteId, signature: SIG }),
    ).toMatchObject({ ok: false, error: 'distribution_mismatch' });

    // At-or-above the reserved amount records the distribution (the excess is
    // unsold public-curve remainder, the operator's, outside the lock scheme).
    deps.chain.tx = chainTx({
      mint: baseMint,
      founderDelta: ALLOC.levyBase + ALLOC.treasuryBase + 12_345n,
    });
    expect(
      await confirmLeftover(deps, { accountId: 1, quoteId: quote.quote.quoteId, signature: SIG }),
    ).toMatchObject({ ok: true });
    const row = deps.tokens.rows.get(7);
    expect(row?.distributeTxSig).toBe(SIG);
    expect(row?.levyAllocBase).toBe(ALLOC.levyBase);

    // The phase-3 lock flow now serves the levy bucket on the curve path...
    const levyLock = await prepareLockQuote(deps, { accountId: 1, realmId: 7, bucket: 'levy' });
    expect(levyLock.ok).toBe(true);
    // ...but never the founder bucket (that vests in the venue locker).
    expect(
      await prepareLockQuote(deps, { accountId: 1, realmId: 7, bucket: 'founder' }),
    ).toMatchObject({ ok: false, error: 'invalid_lock_bucket' });
  });
});
