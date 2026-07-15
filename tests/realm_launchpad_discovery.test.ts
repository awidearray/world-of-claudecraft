// Public launch-discovery orchestration (server/realm_launchpad_discovery.ts,
// the community entry point resolving the gap recorded in BRANCH_STATE.md
// "Open questions surfaced": the vote/presale panels were reachable only from
// the realm owner's dashboard even though the REST routes already serve any
// account). Drives the REAL listLaunchpadDiscovery orchestration against
// in-memory RealmTokenDb / RealmVoteDb / RealmPresaleStore fakes (the same
// voteStatus/presaleInfo functions the owner-facing GET .../token route
// calls), proving: only voting/presale rows surface, every other lifecycle
// status is excluded, and each row carries the real tally/progress payload.

import { describe, expect, it } from 'vitest';
import {
  LAUNCHPAD_DISCOVERY_STATUSES,
  listLaunchpadDiscovery,
} from '../server/realm_launchpad_discovery';
import type {
  PresaleConfig,
  PresaleContribution,
  PresaleCurrency,
  PresaleQuoteRow,
  PresaleRailCaps,
  RealmPresaleStore,
} from '../server/realm_presale';
import type {
  MonetizationPolicy,
  RealmToken,
  RealmTokenDb,
  RealmTokenStatus,
} from '../server/realm_token';
import type { RealmVoteDb, VoteChoice, VoteTally } from '../server/realm_vote';

function token(realmId: number, status: RealmTokenStatus): RealmToken {
  return {
    realmId,
    mint: null,
    decimals: 9,
    symbol: `SYM${realmId}`,
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

// A real (non-hardcoded) filter: exactly mirrors the production SQL semantics
// (WHERE status = ANY(statuses)) over an in-memory row set, proving the
// orchestration test exercises the actual filter contract rather than a fixed
// fixture that happens to already be pre-filtered.
class FakeTokens implements RealmTokenDb {
  rows = new Map<number, RealmToken>();
  names = new Map<number, string>();
  async getRealmToken(realmId: number) {
    return this.rows.get(realmId) ?? null;
  }
  async insertRealmToken(t: {
    realmId: number;
    symbol: string;
    icon: string;
    monetizationPolicy: MonetizationPolicy;
  }): Promise<RealmToken> {
    throw new Error(`unused: ${t.realmId}`);
  }
  async listRealmTokens() {
    return new Map<number, RealmToken>();
  }
  async setRealmTokenStatus() {
    return null;
  }
  async recordMintCreated() {
    return null;
  }
  async recordDistribution() {
    return null;
  }
  async recordLockAddress() {
    return null;
  }
  async recordCurveLaunch() {
    return null;
  }
  async recordLpLock() {
    return null;
  }
  async listByStatus(
    statuses: readonly RealmTokenStatus[],
  ): Promise<Array<RealmToken & { realmName: string }>> {
    const wanted = new Set(statuses);
    return [...this.rows.values()]
      .filter((row) => wanted.has(row.status))
      .map((row) => ({ ...row, realmName: this.names.get(row.realmId) ?? `Realm ${row.realmId}` }));
  }
}

class FakeVotes implements RealmVoteDb {
  rows: Array<{
    realmId: number;
    accountId: number;
    wallet: string;
    choice: VoteChoice;
    weightWoc: bigint;
  }> = [];
  async insertVote(): Promise<void> {
    throw new Error('unused');
  }
  async tallyVotes(realmId: number): Promise<VoteTally> {
    let yesWeight = 0n;
    let noWeight = 0n;
    let voteCount = 0;
    for (const r of this.rows) {
      if (r.realmId !== realmId) continue;
      voteCount++;
      if (r.choice === 'yes') yesWeight += r.weightWoc;
      else noWeight += r.weightWoc;
    }
    return { yesWeight, noWeight, voteCount };
  }
  async getVoteForAccount(realmId: number, accountId: number) {
    const r = this.rows.find((x) => x.realmId === realmId && x.accountId === accountId);
    return r ? { choice: r.choice, weightWoc: r.weightWoc } : null;
  }
}

class FakeStore implements RealmPresaleStore {
  presales = new Map<number, PresaleConfig>();
  contributions: PresaleContribution[] = [];
  async createPresale(): Promise<void> {
    throw new Error('unused');
  }
  async getPresale(realmId: number) {
    return this.presales.get(realmId) ?? null;
  }
  async createQuote(): Promise<void> {
    throw new Error('unused');
  }
  async getQuote(): Promise<PresaleQuoteRow | null> {
    throw new Error('unused');
  }
  async deleteQuote(): Promise<void> {
    throw new Error('unused');
  }
  async raisedByCurrency(realmId: number) {
    const out = new Map<PresaleCurrency, bigint>();
    for (const c of this.contributions) {
      if (c.realmId !== realmId) continue;
      out.set(c.currency, (out.get(c.currency) ?? 0n) + c.amountBase);
    }
    return out;
  }
  async contributedByWallet() {
    return 0n;
  }
  async insertContribution(): Promise<void> {
    throw new Error('unused');
  }
  async getContributionByPaySig(): Promise<PresaleContribution | null> {
    throw new Error('unused');
  }
  async listContributionsForWallet(): Promise<PresaleContribution[]> {
    return [];
  }
  async markRefunded(): Promise<boolean> {
    throw new Error('unused');
  }
  async countUnrefunded() {
    return 0;
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

function makeDeps() {
  const tokens = new FakeTokens();
  const votes = new FakeVotes();
  const store = new FakeStore();
  const deps = {
    tokens,
    votes,
    store,
    walletForAccount: async () => null,
    wocBalance: async () => null,
    rolesForAccountOnRealm: async () => [],
    isUniqueViolation: () => false,
  };
  return { tokens, votes, store, deps };
}

describe('listLaunchpadDiscovery (public launch discovery)', () => {
  it('surfaces only voting/presale realms and excludes every other lifecycle status', async () => {
    const { tokens, deps } = makeDeps();
    const statuses: RealmTokenStatus[] = [
      'prelaunch',
      'voting',
      'presale',
      'funded',
      'refunding',
      'refunded',
      'live',
      'graduated',
      'closed',
    ];
    for (const [i, status] of statuses.entries()) {
      tokens.rows.set(i + 1, token(i + 1, status));
      tokens.names.set(i + 1, `Realm ${status}`);
    }
    const entries = await listLaunchpadDiscovery(deps, null);
    expect(entries.map((e) => e.status).sort()).toEqual(['presale', 'voting']);
    expect(entries.every((e) => LAUNCHPAD_DISCOVERY_STATUSES.includes(e.status))).toBe(true);
    const byStatus = new Map(entries.map((e) => [e.status, e]));
    expect(byStatus.get('voting')?.realmName).toBe('Realm voting');
    expect(byStatus.get('presale')?.realmName).toBe('Realm presale');
  });

  it('a voting realm carries the real weighted tally, not a placeholder', async () => {
    const { tokens, votes, deps } = makeDeps();
    tokens.rows.set(1, token(1, 'voting'));
    tokens.names.set(1, 'Moonlight');
    votes.rows.push({
      realmId: 1,
      accountId: 5,
      wallet: 'W1',
      choice: 'yes',
      weightWoc: 2_000_000n,
    });
    votes.rows.push({ realmId: 1, accountId: 6, wallet: 'W2', choice: 'no', weightWoc: 500_000n });
    const entries = await listLaunchpadDiscovery(deps, null);
    expect(entries).toHaveLength(1);
    expect(entries[0].vote).toMatchObject({
      status: 'voting',
      yesWeight: '2000000',
      noWeight: '500000',
      voteCount: 2,
    });
    expect(entries[0].presale).toBeNull();
  });

  it('a presale realm carries the real raise progress across its rails', async () => {
    const { tokens, store, deps } = makeDeps();
    tokens.rows.set(2, token(2, 'presale'));
    tokens.names.set(2, 'Duskvale');
    store.presales.set(2, {
      realmId: 2,
      escrowWallet: 'EscrowXYZ',
      rails: { SOL: CAPS },
      createdAt: new Date(),
    });
    store.contributions.push({
      contributionId: 1,
      realmId: 2,
      accountId: 9,
      wallet: 'ContribWallet',
      currency: 'SOL',
      amountBase: 500_000n,
      payTxSig: 'sig1',
      refundTxSig: null,
      refundedAt: null,
      createdAt: new Date(),
    });
    const entries = await listLaunchpadDiscovery(deps, null);
    expect(entries).toHaveLength(1);
    expect(entries[0].presale).toMatchObject({
      configured: true,
      progressBps: 5000,
      softCapMet: false,
    });
    expect(entries[0].vote).toBeNull();
  });

  it('a signed-in caller sees their own recorded vote on a discovered realm', async () => {
    const { tokens, votes, deps } = makeDeps();
    tokens.rows.set(3, token(3, 'voting'));
    votes.rows.push({
      realmId: 3,
      accountId: 42,
      wallet: 'MyWallet',
      choice: 'yes',
      weightWoc: 10n,
    });
    const entries = await listLaunchpadDiscovery(deps, 42);
    expect(entries[0].vote?.myChoice).toBe('yes');
    expect(entries[0].vote?.myWeightWoc).toBe('10');
  });

  it('returns an empty list when nothing is voting or in presale', async () => {
    const { tokens, deps } = makeDeps();
    tokens.rows.set(1, token(1, 'live'));
    expect(await listLaunchpadDiscovery(deps, null)).toEqual([]);
  });
});
