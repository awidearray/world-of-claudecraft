// Postgres persistence for the realm token launch vote (launchpad phase 1).
// One weighted, off-chain vote per linked wallet per realm: the voter's $WOC
// weight is SNAPSHOTTED at cast time (weight_woc), so a later balance change
// never rewrites a recorded tally. SQL lives only here; the tally logic,
// quorum/threshold math, and the RealmVoteDb interface live in realm_vote.ts.

import type { Pool, PoolClient } from 'pg';
import type { RealmVoteDb, VoteChoice, VoteTally } from './realm_vote';

type Queryable = Pick<Pool, 'query'> | PoolClient;

export const REALM_VOTE_SCHEMA = `
-- Launch-vote ledger (launchpad phase 1). Off-chain, advisory, weighted by the
-- voter's verified $WOC balance snapshotted at cast time (whole $WOC; the
-- holder-tier reader rounds sub-token dust away anyway). Both uniques matter:
-- one vote per wallet stops the same capital voting twice, one vote per account
-- stops an account rotating linked wallets to stack votes.
CREATE TABLE IF NOT EXISTS realm_votes (
  vote_id BIGSERIAL PRIMARY KEY,
  realm_id BIGINT NOT NULL REFERENCES realms(realm_id) ON DELETE CASCADE,
  account_id INT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  wallet TEXT NOT NULL,
  choice TEXT NOT NULL CHECK (choice IN ('yes', 'no')),
  weight_woc BIGINT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (realm_id, wallet),
  UNIQUE (realm_id, account_id)
);
CREATE INDEX IF NOT EXISTS realm_votes_realm ON realm_votes(realm_id);
`;

export async function insertVote(
  db: Queryable,
  v: { realmId: number; accountId: number; wallet: string; choice: VoteChoice; weightWoc: bigint },
): Promise<void> {
  await db.query(
    `INSERT INTO realm_votes (realm_id, account_id, wallet, choice, weight_woc)
     VALUES ($1, $2, $3, $4, $5)`,
    [v.realmId, v.accountId, v.wallet, v.choice, v.weightWoc.toString()],
  );
}

export async function tallyVotes(db: Queryable, realmId: number): Promise<VoteTally> {
  const res = await db.query(
    `SELECT choice, coalesce(sum(weight_woc), 0)::text AS weight, count(*)::int AS n
       FROM realm_votes WHERE realm_id = $1 GROUP BY choice`,
    [realmId],
  );
  let yesWeight = 0n;
  let noWeight = 0n;
  let voteCount = 0;
  for (const r of res.rows as Array<Record<string, unknown>>) {
    const weight = BigInt(String(r.weight));
    voteCount += Number(r.n);
    if (String(r.choice) === 'yes') yesWeight += weight;
    else noWeight += weight;
  }
  return { yesWeight, noWeight, voteCount };
}

export async function getVoteForAccount(
  db: Queryable,
  realmId: number,
  accountId: number,
): Promise<{ choice: VoteChoice; weightWoc: bigint } | null> {
  const res = await db.query(
    'SELECT choice, weight_woc FROM realm_votes WHERE realm_id = $1 AND account_id = $2',
    [realmId, accountId],
  );
  const r = res.rows[0] as Record<string, unknown> | undefined;
  if (!r) return null;
  return { choice: String(r.choice) as VoteChoice, weightWoc: BigInt(String(r.weight_woc)) };
}

// The pool-bound RealmVoteDb the routes use; tests use an in-memory fake.
export function realmVoteDb(pool: Queryable): RealmVoteDb {
  return {
    insertVote: (v) => insertVote(pool, v),
    tallyVotes: (realmId) => tallyVotes(pool, realmId),
    getVoteForAccount: (realmId, accountId) => getVoteForAccount(pool, realmId, accountId),
  };
}
