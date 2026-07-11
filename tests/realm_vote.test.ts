// Launchpad phase 1 (launch vote): the weighted off-chain tally against
// in-memory RealmTokenDb / RealmVoteDb fakes. Pins the locked identity rule
// (game account + verified linked wallet; unlinked rejected with a typed
// error), the cast-time weight snapshot, one vote per wallet AND per account,
// the exact quorum/threshold bigint math, and the voting -> presale flip on a
// pass (guarded CAS, exactly once).

import { afterEach, describe, expect, it } from 'vitest';
import type {
  MonetizationPolicy,
  RealmToken,
  RealmTokenDb,
  RealmTokenStatus,
} from '../server/realm_token';
import {
  castVote,
  openVote,
  type RealmVoteDb,
  type VoteChoice,
  type VoteDeps,
  type VoteTally,
  voteOutcome,
  voteStatus,
} from '../server/realm_vote';

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
}

interface VoteRow {
  realmId: number;
  accountId: number;
  wallet: string;
  choice: VoteChoice;
  weightWoc: bigint;
}

class FakeVotes implements RealmVoteDb {
  rows: VoteRow[] = [];
  async insertVote(v: VoteRow) {
    for (const r of this.rows) {
      if (r.realmId !== v.realmId) continue;
      if (r.wallet === v.wallet || r.accountId === v.accountId)
        throw new UniqueViolation('dup vote');
    }
    this.rows.push({ ...v });
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

function makeDeps(
  over: {
    status?: RealmTokenStatus;
    balances?: Record<string, number | null>;
    wallets?: Record<number, string | null>;
  } = {},
) {
  const tokens = new FakeTokens();
  tokens.rows.set(7, token(7, over.status ?? 'voting'));
  const votes = new FakeVotes();
  const balances = over.balances ?? {};
  const wallets = over.wallets ?? {};
  const deps: VoteDeps = {
    tokens,
    votes,
    walletForAccount: async (accountId) => {
      const w = accountId in wallets ? wallets[accountId] : `WALLET_${accountId}`;
      return w ? { pubkey: w } : null;
    },
    wocBalance: async (pubkey) => (pubkey in balances ? balances[pubkey] : 100),
    isUniqueViolation: isFakeUnique,
  };
  return { deps, tokens, votes, balances };
}

// Default env: quorum 1,000,000 $WOC, yes threshold 6000 bps.
afterEach(() => {
  delete process.env.REALM_VOTE_QUORUM_WOC;
  delete process.env.REALM_VOTE_YES_THRESHOLD_BPS;
});

describe('voteOutcome (pure quorum + threshold math)', () => {
  const t = (yes: bigint, no: bigint): VoteTally => ({
    yesWeight: yes,
    noWeight: no,
    voteCount: 2,
  });

  it('is pending below quorum regardless of the split', () => {
    expect(voteOutcome(t(999_999n, 0n), 1_000_000n, 6000)).toBe('pending');
  });

  it('passes exactly at quorum and exactly at the threshold (boundary inclusive)', () => {
    // 600,000 yes of 1,000,000 total = exactly 6000 bps at exactly quorum.
    expect(voteOutcome(t(600_000n, 400_000n), 1_000_000n, 6000)).toBe('passed');
  });

  it('fails one base unit under the threshold at quorum', () => {
    expect(voteOutcome(t(599_999n, 400_001n), 1_000_000n, 6000)).toBe('failed');
  });

  it('uses exact bigint math on whale-scale weights', () => {
    const yes = 600_000_000_000_000n;
    const no = 400_000_000_000_000n;
    expect(voteOutcome(t(yes, no), 1_000_000n, 6000)).toBe('passed');
    expect(voteOutcome(t(yes - 1n, no + 1n), 1_000_000n, 6000)).toBe('failed');
  });
});

describe('castVote', () => {
  it('records a weighted vote snapshotted at cast time', async () => {
    const { deps, votes, balances } = makeDeps({ balances: { WALLET_1: 1234.9 } });
    const r = await castVote(deps, { accountId: 1, realmId: 7, choice: 'yes' });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.vote.yesWeight).toBe('1234'); // floored to whole $WOC
    expect(r.vote.myChoice).toBe('yes');
    expect(r.vote.myWeightWoc).toBe('1234');
    // The snapshot holds: a later balance change never rewrites the tally.
    balances.WALLET_1 = 5;
    const after = await votes.tallyVotes(7);
    expect(after.yesWeight).toBe(1234n);
  });

  it('rejects an account with no verified linked wallet with a typed error', async () => {
    const { deps } = makeDeps({ wallets: { 1: null } });
    expect(await castVote(deps, { accountId: 1, realmId: 7, choice: 'yes' })).toMatchObject({
      ok: false,
      status: 400,
      error: 'wallet_not_linked',
    });
  });

  it('rejects a double vote from the same wallet', async () => {
    const { deps } = makeDeps({ wallets: { 1: 'SHARED', 2: 'SHARED' } });
    expect((await castVote(deps, { accountId: 1, realmId: 7, choice: 'yes' })).ok).toBe(true);
    expect(await castVote(deps, { accountId: 2, realmId: 7, choice: 'no' })).toMatchObject({
      ok: false,
      status: 409,
      error: 'already_voted',
    });
  });

  it('rejects a second vote from the same account (wallet rotation)', async () => {
    const { deps } = makeDeps();
    expect((await castVote(deps, { accountId: 1, realmId: 7, choice: 'yes' })).ok).toBe(true);
    // Same account, different linked wallet now: still one vote.
    const rotated = makeDeps({ wallets: { 1: 'ROTATED' } });
    rotated.deps.votes = deps.votes;
    rotated.deps.tokens = deps.tokens;
    expect(await castVote(rotated.deps, { accountId: 1, realmId: 7, choice: 'no' })).toMatchObject({
      ok: false,
      status: 409,
      error: 'already_voted',
    });
  });

  it('rejects when the vote is not open, the choice is malformed, or the weight read fails', async () => {
    expect(
      await castVote(makeDeps({ status: 'prelaunch' }).deps, {
        accountId: 1,
        realmId: 7,
        choice: 'yes',
      }),
    ).toMatchObject({ ok: false, status: 409, error: 'vote_not_open' });
    expect(
      await castVote(makeDeps().deps, { accountId: 1, realmId: 7, choice: 'maybe' }),
    ).toMatchObject({ ok: false, status: 400, error: 'invalid_vote_choice' });
    expect(
      await castVote(makeDeps().deps, { accountId: 1, realmId: 99, choice: 'yes' }),
    ).toMatchObject({ ok: false, status: 404, error: 'token_not_registered' });
    expect(
      await castVote(makeDeps({ balances: { WALLET_1: null } }).deps, {
        accountId: 1,
        realmId: 7,
        choice: 'yes',
      }),
    ).toMatchObject({ ok: false, status: 503, error: 'vote_weight_unavailable' });
    expect(
      await castVote(makeDeps({ balances: { WALLET_1: 0.7 } }).deps, {
        accountId: 1,
        realmId: 7,
        choice: 'yes',
      }),
    ).toMatchObject({ ok: false, status: 409, error: 'no_vote_weight' });
  });

  it('flips voting -> presale exactly when quorum + threshold are met', async () => {
    process.env.REALM_VOTE_QUORUM_WOC = '1000';
    process.env.REALM_VOTE_YES_THRESHOLD_BPS = '6000';
    const { deps, tokens } = makeDeps({ balances: { WALLET_1: 599, WALLET_2: 400, WALLET_3: 1 } });
    // 599 yes / 400 no: below quorum, still voting.
    await castVote(deps, { accountId: 1, realmId: 7, choice: 'yes' });
    let r = await castVote(deps, { accountId: 2, realmId: 7, choice: 'no' });
    expect(r.ok && r.vote.outcome).toBe('pending');
    expect(tokens.rows.get(7)!.status).toBe('voting');
    // +1 yes reaches quorum 1000 with exactly 60% yes: passes and flips.
    r = await castVote(deps, { accountId: 3, realmId: 7, choice: 'yes' });
    expect(r.ok && r.vote.outcome).toBe('passed');
    expect(tokens.rows.get(7)!.status).toBe('presale');
    // Votes after the flip are rejected (the window closed).
    const late = makeDeps();
    late.deps.tokens = tokens;
    late.deps.votes = deps.votes;
    expect(await castVote(late.deps, { accountId: 4, realmId: 7, choice: 'no' })).toMatchObject({
      ok: false,
      error: 'vote_not_open',
    });
  });

  it('meets quorum but fails the threshold: stays voting with outcome failed', async () => {
    process.env.REALM_VOTE_QUORUM_WOC = '1000';
    const { deps, tokens } = makeDeps({ balances: { WALLET_1: 500, WALLET_2: 500 } });
    await castVote(deps, { accountId: 1, realmId: 7, choice: 'yes' });
    const r = await castVote(deps, { accountId: 2, realmId: 7, choice: 'no' });
    expect(r.ok && r.vote.outcome).toBe('failed');
    expect(tokens.rows.get(7)!.status).toBe('voting');
  });
});

describe('voteStatus + openVote', () => {
  it('reports the tally, config, and the caller vote', async () => {
    process.env.REALM_VOTE_QUORUM_WOC = '5000';
    const { deps } = makeDeps({ balances: { WALLET_1: 100 } });
    await castVote(deps, { accountId: 1, realmId: 7, choice: 'yes' });
    const r = await voteStatus(deps, { realmId: 7, accountId: 1 });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.vote).toMatchObject({
      yesWeight: '100',
      noWeight: '0',
      voteCount: 1,
      quorumWoc: '5000',
      yesThresholdBps: 6000,
      outcome: 'pending',
      myChoice: 'yes',
      myWeightWoc: '100',
    });
    const anon = await voteStatus(deps, { realmId: 7, accountId: null });
    expect(anon.ok && anon.vote.myChoice === null).toBe(true);
  });

  it('openVote is owner-only and prelaunch-only', async () => {
    const { deps, tokens } = makeDeps({ status: 'prelaunch' });
    const owner = { tokens, rolesForAccountOnRealm: async () => ['owner'] };
    const stranger = { tokens, rolesForAccountOnRealm: async () => [] as string[] };
    expect(await openVote(stranger, { accountId: 2, realmId: 7 })).toMatchObject({
      ok: false,
      status: 403,
      error: 'not_realm_owner',
    });
    expect(await openVote(owner, { accountId: 1, realmId: 7 })).toMatchObject({
      ok: true,
      status: 'voting',
    });
    // Re-opening (already voting) is a CAS miss.
    expect(await openVote(owner, { accountId: 1, realmId: 7 })).toMatchObject({
      ok: false,
      status: 409,
      error: 'vote_not_openable',
    });
    void deps;
  });
});
