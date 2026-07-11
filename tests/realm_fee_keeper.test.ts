// Launchpad phase 5 (server/realm_fee_keeper.ts): the realm-token fee keeper
// against in-memory fakes. Covers the exact split math (treasury + buyback
// floored, affiliate carved from the operator's gross share, operator absorbs
// every remainder so the legs always sum to the claim), the env caps with the
// operator floor, the fail-closed skips (no operator wallet, under threshold,
// unreadable config), the durable claim -> distribute state machine with
// recovery strictly by recorded signature, and the ledger-pinned legs a
// recovered distribution executes verbatim.

import { describe, expect, it } from 'vitest';
import {
  FEE_OPERATOR_FLOOR_BPS,
  type FeeClaimRow,
  type FeeSplit,
  feeSplitBps,
  feeThresholdBase,
  type RealmFeeDeps,
  type RealmFeeGateway,
  RealmFeeKeeper,
  type RealmFeeStore,
  realmFeeKeeperConfigured,
  type SignedTx,
  splitClaimedFees,
} from '../server/realm_fee_keeper';

// ── Pure split math ──────────────────────────────────────────────────────────

describe('feeSplitBps', () => {
  it('defaults to treasury 2000 / buyback 3000 and caps overrides', () => {
    expect(feeSplitBps({})).toEqual({ treasuryBps: 2000, buybackBps: 3000 });
    expect(feeSplitBps({ REALM_FEE_TREASURY_BPS: '1000', REALM_FEE_BUYBACK_BPS: '4000' })).toEqual({
      treasuryBps: 1000,
      buybackBps: 4000,
    });
    expect(feeSplitBps({ REALM_FEE_TREASURY_BPS: '5001' }).treasuryBps).toBe(2000);
    expect(feeSplitBps({ REALM_FEE_TREASURY_BPS: 'ten' }).treasuryBps).toBe(2000);
  });

  it('enforces the operator floor when the combined shares are too greedy', () => {
    // 5000 + 5000 leaves the operator nothing: reset to defaults.
    const split = feeSplitBps({ REALM_FEE_TREASURY_BPS: '5000', REALM_FEE_BUYBACK_BPS: '5000' });
    expect(split).toEqual({ treasuryBps: 2000, buybackBps: 3000 });
    expect(10_000 - split.treasuryBps - split.buybackBps).toBeGreaterThanOrEqual(
      FEE_OPERATOR_FLOOR_BPS,
    );
  });
});

describe('splitClaimedFees', () => {
  const SPLIT = { treasuryBps: 2000, buybackBps: 3000 };

  it('splits exactly with the affiliate carved from the operator share', () => {
    const s = splitClaimedFees(1_000_000n, SPLIT, 1500);
    expect(s.treasuryBase).toBe(200_000n);
    expect(s.buybackBase).toBe(300_000n);
    // Operator gross 500000; affiliate 15 percent of it.
    expect(s.affiliateBase).toBe(75_000n);
    expect(s.operatorBase).toBe(425_000n);
  });

  it('sums to exactly the claim at adversarial amounts', () => {
    for (const claimed of [1n, 7n, 9999n, 123_456_789_012_345n, 10n ** 18n + 13n]) {
      for (const affiliateBps of [0, 1, 1500, 9999, 10_000]) {
        const s = splitClaimedFees(claimed, SPLIT, affiliateBps);
        expect(s.operatorBase + s.affiliateBase + s.treasuryBase + s.buybackBase).toBe(claimed);
        expect(s.operatorBase).toBeGreaterThanOrEqual(0n);
      }
    }
  });

  it('bounds a hostile affiliate bps and rejects negative claims', () => {
    const s = splitClaimedFees(1000n, SPLIT, 99_999);
    expect(s.affiliateBase).toBe(500n); // clamped to 10000 bps of the gross
    expect(s.operatorBase).toBe(0n);
    expect(() => splitClaimedFees(-1n, SPLIT, 0)).toThrow();
  });
});

describe('config gates', () => {
  it('thresholds are per quote asset and env-tunable', () => {
    expect(feeThresholdBase('', {})).toBe(50_000_000n);
    expect(feeThresholdBase('USDCMint', {})).toBe(25_000_000n);
    expect(feeThresholdBase('', { REALM_FEE_MIN_CLAIM_LAMPORTS: '1' })).toBe(1n);
    expect(feeThresholdBase('USDCMint', { REALM_FEE_MIN_CLAIM_QUOTE_BASE: '7' })).toBe(7n);
  });

  it('the keeper only constructs fully configured', () => {
    expect(realmFeeKeeperConfigured({})).toBe(false);
    expect(realmFeeKeeperConfigured({ REALM_FEE_CLAIMER_SECRET: 's' })).toBe(false);
    expect(
      realmFeeKeeperConfigured({
        REALM_FEE_CLAIMER_SECRET: 's',
        WOC_TREASURY: 'T',
        REALM_BUYBACK_VAULT: 'V',
      }),
    ).toBe(true);
  });
});

// ── Orchestration fakes ──────────────────────────────────────────────────────

const OPERATOR = 'OperatorWallet';
const AFFILIATE = 'AffiliateWallet';
const TREASURY = 'TreasuryWallet';
const BUYBACK = 'BuybackVault';
const POOL = 'CurvePool';
const REALM = 7;

class FakeStore implements RealmFeeStore {
  rows = new Map<string, FeeClaimRow>();
  bySig = new Set<string>();
  async createClaim(row: {
    claimId: string;
    realmId: number;
    poolAddress: string;
    quoteMint: string;
    claimTxSig: string;
  }): Promise<boolean> {
    if (this.bySig.has(row.claimTxSig)) return false;
    this.bySig.add(row.claimTxSig);
    this.rows.set(row.claimId, {
      claimId: row.claimId,
      realmId: row.realmId,
      poolAddress: row.poolAddress,
      quoteMint: row.quoteMint,
      status: 'claiming',
      claimTxSig: row.claimTxSig,
      claimedBase: 0n,
      operatorWallet: null,
      affiliateWallet: null,
      operatorBase: 0n,
      affiliateBase: 0n,
      treasuryBase: 0n,
      buybackBase: 0n,
      distributeTxSig: null,
      distributeBroadcastAt: null,
      createdAt: new Date(),
    });
    return true;
  }
  private patch(claimId: string, patch: Partial<FeeClaimRow>): void {
    const row = this.rows.get(claimId);
    if (row) this.rows.set(claimId, { ...row, ...patch });
  }
  async markClaimed(
    claimId: string,
    fields: {
      claimedBase: bigint;
      operatorWallet: string;
      affiliateWallet: string | null;
      split: FeeSplit;
    },
  ): Promise<void> {
    this.patch(claimId, {
      status: 'claimed',
      claimedBase: fields.claimedBase,
      operatorWallet: fields.operatorWallet,
      affiliateWallet: fields.affiliateWallet,
      operatorBase: fields.split.operatorBase,
      affiliateBase: fields.split.affiliateBase,
      treasuryBase: fields.split.treasuryBase,
      buybackBase: fields.split.buybackBase,
    });
  }
  async markDistributing(claimId: string, sig: string): Promise<void> {
    this.patch(claimId, {
      status: 'distributing',
      distributeTxSig: sig,
      distributeBroadcastAt: new Date(),
    });
  }
  async markDistributed(claimId: string): Promise<void> {
    this.patch(claimId, { status: 'distributed' });
  }
  async markFailed(claimId: string, reason: string): Promise<void> {
    this.patch(claimId, { status: 'failed' });
    this.failures.set(claimId, reason);
  }
  failures = new Map<string, string>();
  async openClaims(): Promise<FeeClaimRow[]> {
    return [...this.rows.values()].filter((r) =>
      ['claiming', 'claimed', 'distributing'].includes(r.status),
    );
  }
}

class FakeGateway implements RealmFeeGateway {
  claimable = new Map<string, bigint>();
  received = new Map<string, bigint>(); // claimSig -> amount
  confirmResults = new Map<string, 'confirmed' | 'failed' | 'unknown'>();
  distributions: Array<{ quoteMint: string; legs: Array<{ dest: string; amountBase: bigint }> }> =
    [];
  claimCounter = 0;
  distributeCounter = 0;
  failSignClaim = false;
  failSignDistribute = false;
  sent: string[] = [];

  async claimableQuoteFees(poolAddress: string): Promise<bigint | null> {
    return this.claimable.get(poolAddress) ?? null;
  }
  async signClaim(args: { poolAddress: string; maxQuoteBase: bigint }): Promise<SignedTx | null> {
    if (this.failSignClaim) return null;
    const signature = `claim-sig-${++this.claimCounter}`;
    this.received.set(signature, args.maxQuoteBase);
    return { signature, send: async () => void this.sent.push(signature) };
  }
  async confirm(signature: string): Promise<'confirmed' | 'failed' | 'unknown'> {
    return this.confirmResults.get(signature) ?? 'confirmed';
  }
  async receivedQuote(claimSig: string): Promise<bigint> {
    return this.received.get(claimSig) ?? 0n;
  }
  async signDistribute(args: {
    quoteMint: string;
    legs: Array<{ dest: string; amountBase: bigint }>;
  }): Promise<SignedTx | null> {
    if (this.failSignDistribute) return null;
    this.distributions.push(args);
    const signature = `dist-sig-${++this.distributeCounter}`;
    return { signature, send: async () => void this.sent.push(signature) };
  }
}

interface Harness {
  keeper: RealmFeeKeeper;
  store: FakeStore;
  gateway: FakeGateway;
  deps: RealmFeeDeps;
}

function harness(over: Partial<RealmFeeDeps> = {}): Harness {
  const store = new FakeStore();
  const gateway = new FakeGateway();
  let ids = 0;
  const deps: RealmFeeDeps = {
    gateway,
    store,
    listFeeTargets: async () => [{ realmId: REALM, poolAddress: POOL }],
    readQuoteMint: async () => '',
    operatorWallet: async () => OPERATOR,
    affiliateFor: async () => ({ wallet: AFFILIATE, bps: 1500 }),
    treasuryWallet: TREASURY,
    buybackWallet: BUYBACK,
    split: { treasuryBps: 2000, buybackBps: 3000 },
    thresholdBase: () => 1_000_000n,
    nativeFeeReserve: 0n,
    now: () => 1_000_000,
    newClaimId: () => `claim-${++ids}`,
    staleMs: 60_000,
    ...over,
  };
  return { keeper: new RealmFeeKeeper(deps), store, gateway, deps };
}

// ── Happy path ───────────────────────────────────────────────────────────────

describe('RealmFeeKeeper cycle', () => {
  it('claims and distributes the exact four-way split', async () => {
    const h = harness();
    h.gateway.claimable.set(POOL, 1_000_000n);
    await h.keeper.runCycle();

    const row = [...h.store.rows.values()][0];
    expect(row.status).toBe('distributed');
    expect(row.claimedBase).toBe(1_000_000n);
    expect(h.gateway.distributions).toHaveLength(1);
    const legs = new Map(h.gateway.distributions[0].legs.map((l) => [l.dest, l.amountBase]));
    expect(legs.get(TREASURY)).toBe(200_000n);
    expect(legs.get(BUYBACK)).toBe(300_000n);
    expect(legs.get(AFFILIATE)).toBe(75_000n);
    expect(legs.get(OPERATOR)).toBe(425_000n);
    // Both transactions actually broadcast, in order.
    expect(h.gateway.sent).toEqual(['claim-sig-1', 'dist-sig-1']);
  });

  it('folds the affiliate leg into the operator when none is attributed', async () => {
    const h = harness({ affiliateFor: async () => null });
    h.gateway.claimable.set(POOL, 1_000_000n);
    await h.keeper.runCycle();
    const legs = new Map(h.gateway.distributions[0].legs.map((l) => [l.dest, l.amountBase]));
    expect(legs.get(OPERATOR)).toBe(500_000n);
    expect(legs.has(AFFILIATE)).toBe(false);
  });

  it('deducts the native fee reserve before splitting', async () => {
    const h = harness({ nativeFeeReserve: 100_000n, affiliateFor: async () => null });
    h.gateway.claimable.set(POOL, 1_000_000n);
    await h.keeper.runCycle();
    const row = [...h.store.rows.values()][0];
    expect(row.claimedBase).toBe(900_000n);
    const legs = h.gateway.distributions[0].legs;
    expect(legs.reduce((sum, l) => sum + l.amountBase, 0n)).toBe(900_000n);
  });

  it('skips below the threshold, without an operator wallet, and with no config', async () => {
    const under = harness();
    under.gateway.claimable.set(POOL, 999_999n);
    await under.keeper.runCycle();
    expect(under.store.rows.size).toBe(0);

    const unlinked = harness({ operatorWallet: async () => null });
    unlinked.gateway.claimable.set(POOL, 5_000_000n);
    await unlinked.keeper.runCycle();
    expect(unlinked.store.rows.size).toBe(0); // fail-closed: nothing claimed

    const dark = harness({ readQuoteMint: async () => null });
    dark.gateway.claimable.set(POOL, 5_000_000n);
    await dark.keeper.runCycle();
    expect(dark.store.rows.size).toBe(0);
  });

  it('marks a reverted claim failed and leaves the fees on-chain', async () => {
    const h = harness();
    h.gateway.claimable.set(POOL, 2_000_000n);
    h.gateway.confirmResults.set('claim-sig-1', 'failed');
    await h.keeper.runCycle();
    const row = [...h.store.rows.values()][0];
    expect(row.status).toBe('failed');
    expect(h.gateway.distributions).toHaveLength(0);
  });
});

// ── Recovery ─────────────────────────────────────────────────────────────────

describe('RealmFeeKeeper recovery', () => {
  it('finishes an unconfirmed claim on the next cycle by its recorded signature', async () => {
    const h = harness();
    h.gateway.claimable.set(POOL, 1_000_000n);
    h.gateway.confirmResults.set('claim-sig-1', 'unknown');
    await h.keeper.runCycle();
    expect([...h.store.rows.values()][0].status).toBe('claiming');

    // Next cycle: the claim confirmed in the meantime. Recovery completes it
    // WITHOUT claiming again (claim counter stays at 1).
    h.gateway.confirmResults.set('claim-sig-1', 'confirmed');
    await h.keeper.runCycle();
    const row = [...h.store.rows.values()][0];
    expect(row.status).toBe('distributed');
    expect(h.gateway.claimCounter).toBe(1);
  });

  it('re-distributes a claimed row from its PINNED legs, not a recomputation', async () => {
    const h = harness();
    h.gateway.claimable.set(POOL, 1_000_000n);
    h.gateway.failSignDistribute = true;
    await h.keeper.runCycle();
    expect([...h.store.rows.values()][0].status).toBe('claimed');

    // The affiliate changes between cycles; the recorded row must win.
    h.gateway.failSignDistribute = false;
    (h.deps as { affiliateFor: RealmFeeDeps['affiliateFor'] }).affiliateFor = async () => ({
      wallet: 'SomeoneElse',
      bps: 9000,
    });
    await h.keeper.runCycle();
    const legs = new Map(h.gateway.distributions[0].legs.map((l) => [l.dest, l.amountBase]));
    expect(legs.get(AFFILIATE)).toBe(75_000n); // the pinned 1500 bps leg
    expect(legs.has('SomeoneElse')).toBe(false);
    expect([...h.store.rows.values()][0].status).toBe('distributed');
  });

  it('re-issues a stale distribution and confirms a landed one without re-sending', async () => {
    const h = harness();
    h.gateway.claimable.set(POOL, 1_000_000n);
    h.gateway.confirmResults.set('dist-sig-1', 'unknown');
    await h.keeper.runCycle();
    expect([...h.store.rows.values()][0].status).toBe('distributing');

    // Landed in the meantime: recovery marks it distributed, no new tx.
    h.gateway.confirmResults.set('dist-sig-1', 'confirmed');
    await h.keeper.runCycle();
    expect([...h.store.rows.values()][0].status).toBe('distributed');
    expect(h.gateway.distributeCounter).toBe(1);
  });

  it('a replayed claim signature is never tracked twice', async () => {
    const h = harness();
    expect(
      await h.store.createClaim({
        claimId: 'a',
        realmId: REALM,
        poolAddress: POOL,
        quoteMint: '',
        claimTxSig: 'dup',
      }),
    ).toBe(true);
    expect(
      await h.store.createClaim({
        claimId: 'b',
        realmId: REALM,
        poolAddress: POOL,
        quoteMint: '',
        claimTxSig: 'dup',
      }),
    ).toBe(false);
  });

  it('never opens new claims while one is in flight', async () => {
    const h = harness();
    h.gateway.claimable.set(POOL, 1_000_000n);
    h.gateway.confirmResults.set('claim-sig-1', 'unknown');
    await h.keeper.runCycle(); // opens claim 1, unconfirmed
    h.gateway.confirmResults.set('claim-sig-1', 'unknown');
    await h.keeper.runCycle(); // recovery only: no second claim
    expect(h.gateway.claimCounter).toBe(1);
    expect(h.store.rows.size).toBe(1);
  });
});
