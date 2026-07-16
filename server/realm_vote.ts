// Realm token launch vote (launchpad phase 1, PRD D4): an off-chain, advisory,
// gas-free tally weighted by each voter's verified $WOC balance. Identity is
// the game account plus its verified linked wallet (the #473 rail): an account
// with no linked wallet is rejected with a typed error, one vote per linked
// wallet (and per account) is enforced by UNIQUE constraints, and the weight is
// read through the existing cachedWocBalance reader and SNAPSHOTTED at cast
// time. A pass (quorum met + yes share over the threshold) flips the realm
// token's status `voting` -> `presale` via the registry's guarded CAS.
//
// No SQL here (realm_vote_db.ts owns it) and no chain writes: this module talks
// to the RealmVoteDb / RealmTokenDb interfaces so tests drive it with in-memory
// fakes. The on-chain SPL Governance path stays a documented upgrade seam.

import { fail, type RealmToken, type RealmTokenDb, type Result } from './realm_token';

export type VoteChoice = 'yes' | 'no';

export function isVoteChoice(raw: string): raw is VoteChoice {
  return raw === 'yes' || raw === 'no';
}

export interface VoteTally {
  yesWeight: bigint; // whole $WOC, snapshotted at each cast
  noWeight: bigint;
  voteCount: number;
}

export interface RealmVoteDb {
  insertVote(v: {
    realmId: number;
    accountId: number;
    wallet: string;
    choice: VoteChoice;
    weightWoc: bigint;
  }): Promise<void>;
  tallyVotes(realmId: number): Promise<VoteTally>;
  getVoteForAccount(
    realmId: number,
    accountId: number,
  ): Promise<{ choice: VoteChoice; weightWoc: bigint } | null>;
}

function intEnv(key: string, def: number, min: number, max: number): number {
  const v = Number.parseInt(process.env[key] ?? '', 10);
  return Number.isFinite(v) && v >= min && v <= max ? v : def;
}

// Quorum: the minimum combined vote weight (whole $WOC) before the vote can
// resolve. Threshold: the yes share of the cast weight, in basis points.
export function voteQuorumWoc(): bigint {
  return BigInt(intEnv('REALM_VOTE_QUORUM_WOC', 1_000_000, 1, 1_000_000_000_000));
}
export function voteYesThresholdBps(): number {
  return intEnv('REALM_VOTE_YES_THRESHOLD_BPS', 6000, 1, 10_000);
}

// Pure outcome math: 'passed' when the quorum is met AND the yes share of the
// cast weight is at or over the threshold; 'failed' when the quorum is met and
// yes is under it; 'pending' below quorum. Exact bigint cross-multiplication,
// no floats.
export function voteOutcome(
  tally: VoteTally,
  quorumWoc: bigint,
  yesThresholdBps: number,
): 'pending' | 'passed' | 'failed' {
  const total = tally.yesWeight + tally.noWeight;
  if (total < quorumWoc) return 'pending';
  return tally.yesWeight * 10_000n >= total * BigInt(yesThresholdBps) ? 'passed' : 'failed';
}

export interface VoteDeps {
  tokens: RealmTokenDb;
  votes: RealmVoteDb;
  // The account's verified linked wallet (#473), or null when none is linked.
  walletForAccount(accountId: number): Promise<{ pubkey: string } | null>;
  // The cached on-chain $WOC balance reader (whole $WOC, null on a failed read).
  wocBalance(pubkey: string): Promise<number | null>;
  isUniqueViolation(err: unknown): boolean;
}

export interface VoteStatus {
  status: RealmToken['status'];
  yesWeight: string;
  noWeight: string;
  voteCount: number;
  quorumWoc: string;
  yesThresholdBps: number;
  outcome: 'pending' | 'passed' | 'failed';
  myChoice: VoteChoice | null;
  myWeightWoc: string | null;
}

async function buildStatus(
  deps: VoteDeps,
  token: RealmToken,
  accountId: number | null,
): Promise<VoteStatus> {
  const tally = await deps.votes.tallyVotes(token.realmId);
  const mine =
    accountId === null ? null : await deps.votes.getVoteForAccount(token.realmId, accountId);
  return {
    status: token.status,
    yesWeight: tally.yesWeight.toString(),
    noWeight: tally.noWeight.toString(),
    voteCount: tally.voteCount,
    quorumWoc: voteQuorumWoc().toString(),
    yesThresholdBps: voteYesThresholdBps(),
    outcome: voteOutcome(tally, voteQuorumWoc(), voteYesThresholdBps()),
    myChoice: mine?.choice ?? null,
    myWeightWoc: mine ? mine.weightWoc.toString() : null,
  };
}

// The vote panel read: the current weighted tally + quorum/threshold config +
// the caller's own recorded vote (when signed in).
export async function voteStatus(
  deps: VoteDeps,
  args: { realmId: number; accountId: number | null },
): Promise<Result<{ vote: VoteStatus }>> {
  const token = await deps.tokens.getRealmToken(args.realmId);
  if (!token) return fail(404, 'token_not_registered');
  return { ok: true, vote: await buildStatus(deps, token, args.accountId) };
}

// Cast one weighted vote. Identity = game account + verified linked wallet;
// weight = the wallet's cached $WOC balance, floored to whole $WOC and
// snapshotted into the ledger row. On a pass the token flips voting -> presale
// (guarded CAS, so a concurrent pass flips exactly once).
export async function castVote(
  deps: VoteDeps,
  args: { accountId: number; realmId: number; choice: string },
): Promise<Result<{ vote: VoteStatus }>> {
  if (!isVoteChoice(args.choice)) return fail(400, 'invalid_vote_choice');
  const token = await deps.tokens.getRealmToken(args.realmId);
  if (!token) return fail(404, 'token_not_registered');
  if (token.status !== 'voting') return fail(409, 'vote_not_open');

  const wallet = await deps.walletForAccount(args.accountId);
  if (!wallet) return fail(400, 'wallet_not_linked');

  const balance = await deps.wocBalance(wallet.pubkey);
  if (balance === null) return fail(503, 'vote_weight_unavailable');
  const weightWoc = BigInt(Math.max(0, Math.floor(balance)));
  if (weightWoc <= 0n) return fail(409, 'no_vote_weight');

  try {
    await deps.votes.insertVote({
      realmId: args.realmId,
      accountId: args.accountId,
      wallet: wallet.pubkey,
      choice: args.choice,
      weightWoc,
    });
  } catch (err) {
    if (deps.isUniqueViolation(err)) return fail(409, 'already_voted');
    throw err;
  }

  const tally = await deps.votes.tallyVotes(args.realmId);
  let current = token;
  if (voteOutcome(tally, voteQuorumWoc(), voteYesThresholdBps()) === 'passed') {
    const flipped = await deps.tokens.setRealmTokenStatus(args.realmId, ['voting'], 'presale');
    if (flipped) current = flipped;
  }
  return { ok: true, vote: await buildStatus(deps, current, args.accountId) };
}

// Owner opens the community vote: prelaunch -> voting (guarded CAS).
export async function openVote(
  deps: Pick<VoteDeps, 'tokens'> & {
    rolesForAccountOnRealm(realmId: number, accountId: number): Promise<string[]>;
  },
  args: { accountId: number; realmId: number },
): Promise<Result<{ status: RealmToken['status'] }>> {
  const roles = await deps.rolesForAccountOnRealm(args.realmId, args.accountId);
  if (!roles.includes('owner')) return fail(403, 'not_realm_owner');
  const token = await deps.tokens.getRealmToken(args.realmId);
  if (!token) return fail(404, 'token_not_registered');
  const flipped = await deps.tokens.setRealmTokenStatus(args.realmId, ['prelaunch'], 'voting');
  if (!flipped) return fail(409, 'vote_not_openable');
  return { ok: true, status: flipped.status };
}
