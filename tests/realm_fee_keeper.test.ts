// Launchpad phase 5 fee keeper orchestration (server/realm_fee_keeper.ts): the
// verify-and-accrue claim registration, the drain cycle's four-leg
// ledger-first payout, the advisory-lock no-double-spend (a contended realm is
// skipped, never double-paid), crash recovery by recorded leg signature, and
// the floor / unpayable / missing-config guards, all over in-memory fakes.

import { Keypair } from '@solana/web3.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  FeeDistributionLeg,
  FeeDistributionRow,
  FeeExecutor,
  FeeKeeperDeps,
  FeeVaultCurrency,
  RealmFeeStore,
} from '../server/realm_fee_keeper';
import { listClaimableFees, registerFeeClaim, runFeeCycle } from '../server/realm_fee_keeper';
import { StubLaunchVenue } from '../server/realm_launchpad';
import { DEFAULT_ALLOCATION_BPS } from '../server/realm_token_alloc';
import { fetchFinalizedTransaction, type RawConfirmedTransaction } from '../server/solana_rpc';

vi.mock('../server/solana_rpc', async (importActual) => {
  const actual = await importActual<typeof import('../server/solana_rpc')>();
  return { ...actual, fetchFinalizedTransaction: vi.fn() };
});

const VAULT = Keypair.fromSeed(new Uint8Array(32).fill(7)).publicKey.toBase58();
const OPERATOR = Keypair.fromSeed(new Uint8Array(32).fill(1)).publicKey.toBase58();
const TREASURY = Keypair.fromSeed(new Uint8Array(32).fill(2)).publicKey.toBase58();
const AFFILIATE = Keypair.fromSeed(new Uint8Array(32).fill(3)).publicKey.toBase58();
const BURN_DEST = Keypair.fromSeed(new Uint8Array(32).fill(4)).publicKey.toBase58();
const POOL = Keypair.fromSeed(new Uint8Array(32).fill(5)).publicKey.toBase58();
const SIG = '5'.repeat(80);

beforeEach(() => {
  process.env.REALM_FEE_TREASURY_WALLET = TREASURY;
  process.env.REALM_FEE_BURN_DEST = BURN_DEST;
});
afterEach(() => {
  delete process.env.REALM_FEE_TREASURY_WALLET;
  delete process.env.REALM_FEE_BURN_DEST;
  delete process.env.REALM_FEE_MIN_DRAIN_USDC_BASE;
  vi.mocked(fetchFinalizedTransaction).mockReset();
});

// ── In-memory fee store ───────────────────────────────────────────────────────

interface AccrualRow {
  realmId: number;
  currency: FeeVaultCurrency;
  amountBase: bigint;
  claimTxSig: string;
}

class FakeFeeStore implements RealmFeeStore {
  accruals: AccrualRow[] = [];
  distributions = new Map<number, FeeDistributionRow>();
  realms: Array<{ realmId: number; poolAddress: string; feeClaimerPda: string | null }> = [];
  locked = new Set<number>();
  private nextId = 1;

  async insertAccrual(a: AccrualRow) {
    if (this.accruals.some((x) => x.claimTxSig === a.claimTxSig)) return false;
    this.accruals.push({ ...a });
    return true;
  }
  async unspentAccruedBase(realmId: number, currency: FeeVaultCurrency) {
    const inflow = this.accruals
      .filter((a) => a.realmId === realmId && a.currency === currency)
      .reduce((s, a) => s + a.amountBase, 0n);
    const outflow = [...this.distributions.values()]
      .filter((d) => d.realmId === realmId && d.currency === currency && d.status !== 'failed')
      .reduce((s, d) => s + d.totalBase, 0n);
    const v = inflow - outflow;
    return v > 0n ? v : 0n;
  }
  async createDistribution(d: {
    realmId: number;
    currency: FeeVaultCurrency;
    totalBase: bigint;
    operatorBase: bigint;
    treasuryBase: bigint;
    affiliateBase: bigint;
    burnBase: bigint;
    operatorWallet: string;
    treasuryWallet: string;
    affiliateWallet: string | null;
    burnDest: string;
  }) {
    const id = this.nextId++;
    this.distributions.set(id, {
      distributionId: id,
      ...d,
      status: 'paying',
      legSigs: { operator: null, treasury: null, affiliate: null, burn: null },
      legPaid: { operator: false, treasury: false, affiliate: false, burn: false },
      lastBroadcastAt: null,
      createdAt: new Date(),
    });
    return id;
  }
  async openDistribution(realmId: number, currency: FeeVaultCurrency) {
    for (const d of this.distributions.values()) {
      if (d.realmId === realmId && d.currency === currency && d.status === 'paying') return d;
    }
    return null;
  }
  async recordLegSig(distributionId: number, leg: FeeDistributionLeg, sig: string) {
    const d = this.distributions.get(distributionId);
    if (d) {
      d.legSigs[leg] = sig;
      d.lastBroadcastAt = new Date();
    }
  }
  async markLegPaid(distributionId: number, leg: FeeDistributionLeg) {
    const d = this.distributions.get(distributionId);
    if (d) d.legPaid[leg] = true;
  }
  async markPaid(distributionId: number) {
    const d = this.distributions.get(distributionId);
    if (d && d.status === 'paying') d.status = 'paid';
  }
  async markFailed(distributionId: number, reason: string) {
    const d = this.distributions.get(distributionId);
    if (d && d.status === 'paying') {
      d.status = 'failed';
      d.reason = reason;
    }
  }
  async listFeeRealms() {
    return this.realms;
  }
  async withRealmFeeLock<T>(realmId: number, fn: () => Promise<T>): Promise<T | null> {
    if (this.locked.has(realmId)) return null;
    this.locked.add(realmId);
    try {
      return await fn();
    } finally {
      this.locked.delete(realmId);
    }
  }
}

// A recording executor whose confirm result is scriptable per signature.
class FakeExec implements FeeExecutor {
  transfers: Array<{ dest: string; amountBase: bigint; currency: FeeVaultCurrency; sig: string }> =
    [];
  confirmResult: 'confirmed' | 'failed' | 'unknown' = 'confirmed';
  private n = 0;
  vaultAddress() {
    return VAULT;
  }
  async signTransfer(dest: string, amountBase: bigint, currency: FeeVaultCurrency) {
    const sig = `settle-${this.n++}`;
    this.transfers.push({ dest, amountBase, currency, sig });
    return { signature: sig, send: async () => {} };
  }
  async confirm() {
    return this.confirmResult;
  }
}

function makeDeps(over: Partial<FeeKeeperDeps> = {}): FeeKeeperDeps & {
  store: FakeFeeStore;
  exec: FakeExec;
} {
  const store = new FakeFeeStore();
  store.realms = [{ realmId: 7, poolAddress: POOL, feeClaimerPda: 'FeeVault' }];
  const exec = new FakeExec();
  return {
    store,
    exec,
    venue: null,
    operatorWalletForRealm: async () => OPERATOR,
    affiliateForRealm: async () => ({ wallet: AFFILIATE, bps: 1500 }),
    now: () => 1_000_000_000,
    ...over,
  } as FeeKeeperDeps & { store: FakeFeeStore; exec: FakeExec };
}

function feeTx(owner: string, currency: FeeVaultCurrency, amount: bigint): RawConfirmedTransaction {
  if (currency === 'SOL') {
    return {
      meta: { err: null, preBalances: [0], postBalances: [Number(amount)] },
      transaction: { message: { accountKeys: [owner], instructions: [] } },
    } as RawConfirmedTransaction;
  }
  return {
    meta: {
      err: null,
      preTokenBalances: [],
      postTokenBalances: [
        {
          owner,
          mint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
          programId: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
          uiTokenAmount: { amount: amount.toString() },
        },
      ],
    },
    transaction: { message: { accountKeys: [owner], instructions: [] } },
  } as RawConfirmedTransaction;
}

// ── registerFeeClaim ──────────────────────────────────────────────────────────

describe('registerFeeClaim', () => {
  it('verifies a finalized USDC claim into the vault and accrues it once', async () => {
    const deps = makeDeps();
    vi.mocked(fetchFinalizedTransaction).mockResolvedValue(feeTx(VAULT, 'USDC', 5_000_000n));
    const result = await registerFeeClaim(deps, { realmId: 7, currency: 'USDC', signature: SIG });
    expect(result).toMatchObject({ ok: true, amountBase: '5000000' });
    expect(await deps.store.unspentAccruedBase(7, 'USDC')).toBe(5_000_000n);
    // Replay: the UNIQUE(claim_tx_sig) guard rejects the same signature.
    vi.mocked(fetchFinalizedTransaction).mockResolvedValue(feeTx(VAULT, 'USDC', 5_000_000n));
    expect(
      await registerFeeClaim(deps, { realmId: 7, currency: 'USDC', signature: SIG }),
    ).toMatchObject({ ok: false, error: 'launch_sig_reused' });
  });

  it('rejects a claim that did not credit the vault', async () => {
    const deps = makeDeps();
    vi.mocked(fetchFinalizedTransaction).mockResolvedValue(feeTx(OPERATOR, 'USDC', 5_000_000n));
    expect(
      await registerFeeClaim(deps, { realmId: 7, currency: 'USDC', signature: SIG }),
    ).toMatchObject({ ok: false, error: 'claim_not_credited' });
  });

  it('rejects unknown realm, bad currency, bad sig, and an unfinalized tx', async () => {
    const deps = makeDeps();
    expect(
      await registerFeeClaim(deps, { realmId: 9, currency: 'USDC', signature: SIG }),
    ).toMatchObject({ ok: false, error: 'curve_not_launched' });
    expect(
      await registerFeeClaim(deps, { realmId: 7, currency: 'EUR', signature: SIG }),
    ).toMatchObject({ ok: false, error: 'invalid_currency' });
    expect(
      await registerFeeClaim(deps, { realmId: 7, currency: 'USDC', signature: 'l1O0' }),
    ).toMatchObject({ ok: false, error: 'bad_signature' });
    vi.mocked(fetchFinalizedTransaction).mockResolvedValue(null);
    expect(
      await registerFeeClaim(deps, { realmId: 7, currency: 'USDC', signature: SIG }),
    ).toMatchObject({ ok: false, error: 'not_finalized' });
  });
});

// ── runFeeCycle ───────────────────────────────────────────────────────────────

describe('runFeeCycle', () => {
  let seedN = 0;
  async function seedAccrual(deps: ReturnType<typeof makeDeps>, amount: bigint) {
    await deps.store.insertAccrual({
      realmId: 7,
      currency: 'USDC',
      amountBase: amount,
      claimTxSig: `claim-${seedN++}`,
    });
  }

  it('drains an accrued balance into the four legs, ledger-first', async () => {
    const deps = makeDeps();
    await seedAccrual(deps, 1_000_000n);
    const reports = await runFeeCycle(deps);
    const usdc = reports.find((r) => r.realmId === 7 && r.currency === 'USDC');
    expect(usdc?.action).toBe('paid');
    // Four transfers with the exact split (50/20/30, affiliate 15% of operator).
    const byDest = new Map(deps.exec.transfers.map((t) => [t.dest, t.amountBase]));
    expect(byDest.get(TREASURY)).toBe(200_000n);
    expect(byDest.get(BURN_DEST)).toBe(300_000n);
    expect(byDest.get(AFFILIATE)).toBe(75_000n);
    expect(byDest.get(OPERATOR)).toBe(425_000n);
    const dist = [...deps.store.distributions.values()][0];
    expect(dist.status).toBe('paid');
    expect(dist.legPaid).toEqual({ operator: true, treasury: true, affiliate: true, burn: true });
  });

  it('skips below the drain floor and when the operator has no wallet', async () => {
    const deps = makeDeps({ operatorWalletForRealm: async () => null });
    await seedAccrual(deps, 500_000n); // under the 1 USDC floor
    let reports = await runFeeCycle(deps);
    expect(reports.find((r) => r.currency === 'USDC')?.action).toBe('skipped_below_floor');
    // Above the floor but no operator wallet: unpayable, nothing spent.
    await seedAccrual(deps, 5_000_000n);
    reports = await runFeeCycle(deps);
    expect(reports.find((r) => r.currency === 'USDC')?.action).toBe('skipped_unpayable');
    expect(deps.exec.transfers).toHaveLength(0);
  });

  it('does nothing without a treasury or burn destination', async () => {
    delete process.env.REALM_FEE_TREASURY_WALLET;
    const deps = makeDeps();
    await seedAccrual(deps, 5_000_000n);
    expect(await runFeeCycle(deps)).toEqual([]);
  });

  it('advisory lock: a contended realm is skipped, never double-paid', async () => {
    const deps = makeDeps();
    await seedAccrual(deps, 5_000_000n);
    deps.store.locked.add(7); // another holder owns the realm
    const reports = await runFeeCycle(deps);
    expect(reports.every((r) => r.action === 'skipped_locked')).toBe(true);
    expect(deps.exec.transfers).toHaveLength(0);
  });

  it('recovers a half-paid distribution by recorded leg signature (no double-pay)', async () => {
    const deps = makeDeps();
    await seedAccrual(deps, 1_000_000n);
    // First cycle: the affiliate leg fails to confirm, leaving the batch open.
    deps.exec.confirmResult = 'confirmed';
    const store = deps.store;
    // Patch confirm to fail once the operator + treasury legs are done.
    let calls = 0;
    deps.exec.confirm = async () => {
      calls++;
      return calls <= 2 ? 'confirmed' : 'unknown';
    };
    await runFeeCycle(deps);
    const dist = [...store.distributions.values()][0];
    expect(dist.status).toBe('paying');
    expect(dist.legPaid.operator).toBe(true);
    expect(dist.legPaid.treasury).toBe(true);
    expect(dist.legPaid.affiliate).toBe(false);
    const paidBefore = deps.exec.transfers.length;

    // Second cycle: the affiliate leg was ALREADY broadcast in cycle 1, so
    // recovery confirms it by its recorded signature and does NOT re-send it
    // (the no-double-pay guarantee); only the burn leg, which was never
    // attempted, sends a new transfer.
    deps.exec.confirm = async () => 'confirmed';
    await runFeeCycle(deps);
    expect(dist.status).toBe('paid');
    expect(deps.exec.transfers.length).toBe(paidBefore + 1);
    // The realm's balance is fully consumed by the one distribution.
    expect(await store.unspentAccruedBase(7, 'USDC')).toBe(0n);
  });
});

// ── listClaimableFees ─────────────────────────────────────────────────────────

describe('listClaimableFees', () => {
  it('reads live claimable partner fees per curve realm through the venue', async () => {
    const venue = new StubLaunchVenue();
    const prepared = await venue.prepareCurveLaunch({
      plan: {
        quote: 'SOL',
        quoteMint: 'So11111111111111111111111111111111111111112',
        quoteDecimals: 9,
        supplyTokens: 1_000_000_000,
        supplyBase: 10n ** 18n,
        decimals: 9,
        publicCurveTokens: 600_000_000,
        liquidityPercent: DEFAULT_ALLOCATION_BPS.liquidity / 100,
        founderVestingTokens: 120_000_000,
        founderAllocBase: 12n * 10n ** 16n,
        levyAllocBase: 8n * 10n ** 16n,
        treasuryAllocBase: 10n ** 17n,
        leftoverTokens: 180_000_000,
        vesting: { cliffFromMigrationSec: 100, frequencySec: 10, numberOfPeriod: 36 },
        fees: {
          startingFeeBps: 2000,
          endingFeeBps: 100,
          numberOfPeriod: 120,
          totalDurationSec: 3600,
          creatorTradingFeePercentage: 50,
        },
        migrationQuoteThresholdHuman: 100,
        feeClaimer: 'FeeVault11111111111111111111111111111111111',
        leftoverReceiver: OPERATOR,
      },
      founderWallet: OPERATOR,
      symbol: 'MOON',
      name: 'MOON',
      uri: '',
    });
    const store = new FakeFeeStore();
    store.realms = [{ realmId: 7, poolAddress: prepared!.poolAddress, feeClaimerPda: 'FeeVault' }];
    const exec = new FakeExec();
    const claimable = await listClaimableFees({ store, exec, venue });
    expect(claimable).toHaveLength(1);
    expect(claimable[0]).toMatchObject({ realmId: 7, receiver: VAULT });
  });
});
