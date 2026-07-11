// Postgres persistence for the realm token registry (launchpad phase 0). The
// domain types, validation, and the RealmTokenDb interface live in
// realm_token.ts; this module only persists (SQL lives only in *_db.ts, see
// server/CLAUDE.md). The schema is appended to the main ensureSchema() run in
// db.ts, after REALM_SCHEMA (it FK-references realms), and the columns are
// asserted at boot by assertRealmSchema (realm_db.ts) so a dropped column fails
// fast instead of at query time.

import type { Pool, PoolClient } from 'pg';
import {
  isMonetizationPolicy,
  isRealmTokenStatus,
  type MonetizationPolicy,
  type RealmToken,
  type RealmTokenDb,
  type RealmTokenStatus,
} from './realm_token';

type Queryable = Pick<Pool, 'query'> | PoolClient;

export const REALM_TOKEN_SCHEMA = `
-- Per-realm token registry (launchpad phase 0). One optional currency identity
-- per realm: symbol/icon display, the launch lifecycle, the (storage-only)
-- monetization policy, and the chain addresses the later phases fill in. The
-- mint stays NULL until the phase-3 mint factory creates it; launch_tx_sig is
-- the UNIQUE replay guard for that future launch transaction.
CREATE TABLE IF NOT EXISTS realm_tokens (
  realm_id BIGINT PRIMARY KEY REFERENCES realms(realm_id) ON DELETE CASCADE,
  mint TEXT UNIQUE,
  decimals SMALLINT NOT NULL DEFAULT 9,
  symbol TEXT NOT NULL,
  icon TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'prelaunch'
    CHECK (status IN ('prelaunch', 'voting', 'presale', 'funded', 'refunding', 'refunded',
                      'live', 'graduated', 'closed')),
  monetization_policy TEXT NOT NULL DEFAULT 'cosmetic'
    CHECK (monetization_policy IN ('cosmetic', 'power')),
  curve_address TEXT,
  pool_address TEXT,
  lp_lock_address TEXT,
  fee_claimer_pda TEXT,
  launch_tx_sig TEXT UNIQUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS realm_tokens_status ON realm_tokens(status);
`;

const TOKEN_COLS = `realm_id, mint, decimals, symbol, icon, status, monetization_policy,
  curve_address, pool_address, lp_lock_address, fee_claimer_pda, launch_tx_sig,
  created_at, updated_at`;

function rowToToken(r: Record<string, unknown>): RealmToken {
  const status = String(r.status);
  const policy = String(r.monetization_policy);
  return {
    realmId: Number(r.realm_id),
    mint: r.mint == null ? null : String(r.mint),
    decimals: Number(r.decimals),
    symbol: String(r.symbol),
    icon: String(r.icon),
    status: isRealmTokenStatus(status) ? status : 'closed',
    monetizationPolicy: isMonetizationPolicy(policy) ? policy : 'cosmetic',
    curveAddress: r.curve_address == null ? null : String(r.curve_address),
    poolAddress: r.pool_address == null ? null : String(r.pool_address),
    lpLockAddress: r.lp_lock_address == null ? null : String(r.lp_lock_address),
    feeClaimerPda: r.fee_claimer_pda == null ? null : String(r.fee_claimer_pda),
    launchTxSig: r.launch_tx_sig == null ? null : String(r.launch_tx_sig),
    createdAt: r.created_at as Date,
    updatedAt: r.updated_at as Date,
  };
}

export async function getRealmToken(db: Queryable, realmId: number): Promise<RealmToken | null> {
  const res = await db.query(`SELECT ${TOKEN_COLS} FROM realm_tokens WHERE realm_id = $1`, [
    realmId,
  ]);
  return res.rows[0] ? rowToToken(res.rows[0]) : null;
}

export async function insertRealmToken(
  db: Queryable,
  t: { realmId: number; symbol: string; icon: string; monetizationPolicy: MonetizationPolicy },
): Promise<RealmToken> {
  const res = await db.query(
    `INSERT INTO realm_tokens (realm_id, symbol, icon, monetization_policy)
     VALUES ($1, $2, $3, $4)
     RETURNING ${TOKEN_COLS}`,
    [t.realmId, t.symbol, t.icon, t.monetizationPolicy],
  );
  return rowToToken(res.rows[0]);
}

// Tokens for a set of realms (the directory merge), keyed by realm_id.
export async function listRealmTokens(
  db: Queryable,
  realmIds: number[],
): Promise<Map<number, RealmToken>> {
  const out = new Map<number, RealmToken>();
  if (realmIds.length === 0) return out;
  const res = await db.query(
    `SELECT ${TOKEN_COLS} FROM realm_tokens WHERE realm_id = ANY($1::bigint[])`,
    [realmIds],
  );
  for (const r of res.rows) {
    const row = rowToToken(r);
    out.set(row.realmId, row);
  }
  return out;
}

// Guarded lifecycle CAS: flip the status only when the current status is one of
// `from`. Two concurrent flips (or a flip racing a teardown) cannot both match,
// mirroring activateRealm's row-locked CAS. Returns null when nothing matched.
export async function setRealmTokenStatus(
  db: Queryable,
  realmId: number,
  from: readonly RealmTokenStatus[],
  to: RealmTokenStatus,
): Promise<RealmToken | null> {
  const res = await db.query(
    `UPDATE realm_tokens SET status = $2, updated_at = now()
      WHERE realm_id = $1 AND status = ANY($3::text[])
      RETURNING ${TOKEN_COLS}`,
    [realmId, to, [...from]],
  );
  return res.rows[0] ? rowToToken(res.rows[0]) : null;
}

// The pool-bound RealmTokenDb the routes use; tests substitute an in-memory fake
// implementing the same interface from realm_token.ts.
export function realmTokenDb(pool: Queryable): RealmTokenDb {
  return {
    getRealmToken: (realmId) => getRealmToken(pool, realmId),
    insertRealmToken: (t) => insertRealmToken(pool, t),
    listRealmTokens: (realmIds) => listRealmTokens(pool, realmIds),
    setRealmTokenStatus: (realmId, from, to) => setRealmTokenStatus(pool, realmId, from, to),
  };
}
