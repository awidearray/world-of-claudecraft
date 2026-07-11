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
  distribute_tx_sig TEXT UNIQUE,
  supply_base NUMERIC(30, 0),
  founder_alloc_base NUMERIC(30, 0),
  levy_alloc_base NUMERIC(30, 0),
  treasury_alloc_base NUMERIC(30, 0),
  founder_lock_address TEXT,
  levy_lock_address TEXT,
  treasury_lock_address TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS realm_tokens_status ON realm_tokens(status);
-- Phase-3 launch columns, added for databases created on the phase-0 shape
-- (CREATE TABLE IF NOT EXISTS never grows an existing table; assertRealmSchema
-- fails the boot if any of these went missing after this ran).
ALTER TABLE realm_tokens ADD COLUMN IF NOT EXISTS distribute_tx_sig TEXT UNIQUE;
ALTER TABLE realm_tokens ADD COLUMN IF NOT EXISTS supply_base NUMERIC(30, 0);
ALTER TABLE realm_tokens ADD COLUMN IF NOT EXISTS founder_alloc_base NUMERIC(30, 0);
ALTER TABLE realm_tokens ADD COLUMN IF NOT EXISTS levy_alloc_base NUMERIC(30, 0);
ALTER TABLE realm_tokens ADD COLUMN IF NOT EXISTS treasury_alloc_base NUMERIC(30, 0);
ALTER TABLE realm_tokens ADD COLUMN IF NOT EXISTS founder_lock_address TEXT;
ALTER TABLE realm_tokens ADD COLUMN IF NOT EXISTS levy_lock_address TEXT;
ALTER TABLE realm_tokens ADD COLUMN IF NOT EXISTS treasury_lock_address TEXT;
`;

const TOKEN_COLS = `realm_id, mint, decimals, symbol, icon, status, monetization_policy,
  curve_address, pool_address, lp_lock_address, fee_claimer_pda, launch_tx_sig,
  distribute_tx_sig, supply_base, founder_alloc_base, levy_alloc_base, treasury_alloc_base,
  founder_lock_address, levy_lock_address, treasury_lock_address,
  created_at, updated_at`;

function rowToToken(r: Record<string, unknown>): RealmToken {
  const status = String(r.status);
  const policy = String(r.monetization_policy);
  // NUMERIC comes back as a string; read as bigint, never a JS number.
  const big = (v: unknown): bigint | null => (v == null ? null : BigInt(String(v)));
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
    distributeTxSig: r.distribute_tx_sig == null ? null : String(r.distribute_tx_sig),
    supplyBase: big(r.supply_base),
    founderAllocBase: big(r.founder_alloc_base),
    levyAllocBase: big(r.levy_alloc_base),
    treasuryAllocBase: big(r.treasury_alloc_base),
    founderLockAddress: r.founder_lock_address == null ? null : String(r.founder_lock_address),
    levyLockAddress: r.levy_lock_address == null ? null : String(r.levy_lock_address),
    treasuryLockAddress: r.treasury_lock_address == null ? null : String(r.treasury_lock_address),
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

// ── Phase-3 launch writes (each a guarded CAS on its own null column) ─────────

// Record the verified mint creation. Guarded on mint IS NULL AND status
// 'funded' (the only state a mint may be created from); launch_tx_sig UNIQUE
// makes a cross-realm signature replay a unique violation for the caller.
export async function recordMintCreated(
  db: Queryable,
  realmId: number,
  mint: string,
  launchTxSig: string,
): Promise<RealmToken | null> {
  const res = await db.query(
    `UPDATE realm_tokens SET mint = $2, launch_tx_sig = $3, updated_at = now()
      WHERE realm_id = $1 AND mint IS NULL AND status = 'funded'
      RETURNING ${TOKEN_COLS}`,
    [realmId, mint, launchTxSig],
  );
  return res.rows[0] ? rowToToken(res.rows[0]) : null;
}

// Record the verified distribute-and-renounce transaction plus the exact
// bucket amounts it minted (pinned so the later lock verification can never
// drift from what was actually distributed, even across an env change).
export async function recordDistribution(
  db: Queryable,
  realmId: number,
  d: {
    distributeTxSig: string;
    supplyBase: bigint;
    founderAllocBase: bigint;
    levyAllocBase: bigint;
    treasuryAllocBase: bigint;
  },
): Promise<RealmToken | null> {
  const res = await db.query(
    `UPDATE realm_tokens
        SET distribute_tx_sig = $2, supply_base = $3, founder_alloc_base = $4,
            levy_alloc_base = $5, treasury_alloc_base = $6, updated_at = now()
      WHERE realm_id = $1 AND distribute_tx_sig IS NULL AND mint IS NOT NULL
      RETURNING ${TOKEN_COLS}`,
    [
      realmId,
      d.distributeTxSig,
      d.supplyBase.toString(),
      d.founderAllocBase.toString(),
      d.levyAllocBase.toString(),
      d.treasuryAllocBase.toString(),
    ],
  );
  return res.rows[0] ? rowToToken(res.rows[0]) : null;
}

// The three lock-address columns, written once each after on-chain
// verification. The column is resolved from a closed map, never interpolated
// from input.
const LOCK_COLUMNS = {
  founder: 'founder_lock_address',
  levy: 'levy_lock_address',
  treasury: 'treasury_lock_address',
} as const;

export async function recordLockAddress(
  db: Queryable,
  realmId: number,
  bucket: keyof typeof LOCK_COLUMNS,
  address: string,
): Promise<RealmToken | null> {
  const col = LOCK_COLUMNS[bucket];
  // A lock can be recorded after the phase-3 distribution OR on the curve
  // path (the founder locker lands at migration, before the leftover
  // withdrawal that plays the distribution role there).
  const res = await db.query(
    `UPDATE realm_tokens SET ${col} = $2, updated_at = now()
      WHERE realm_id = $1 AND ${col} IS NULL
        AND (distribute_tx_sig IS NOT NULL OR curve_address IS NOT NULL)
      RETURNING ${TOKEN_COLS}`,
    [realmId, address],
  );
  return res.rows[0] ? rowToToken(res.rows[0]) : null;
}

// Phase 4: one guarded write records the whole verified curve launch. The
// launch_tx_sig UNIQUE doubles as the cross-realm replay guard, exactly like
// the phase-3 mint path.
export async function recordCurveLaunch(
  db: Queryable,
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
): Promise<RealmToken | null> {
  const res = await db.query(
    `UPDATE realm_tokens
        SET mint = $2, launch_tx_sig = $3, curve_address = $4, pool_address = $5,
            fee_claimer_pda = $6, supply_base = $7, founder_alloc_base = $8,
            levy_alloc_base = $9, treasury_alloc_base = $10, updated_at = now()
      WHERE realm_id = $1 AND mint IS NULL AND curve_address IS NULL AND status = 'funded'
      RETURNING ${TOKEN_COLS}`,
    [
      realmId,
      d.mint,
      d.launchTxSig,
      d.curveAddress,
      d.poolAddress,
      d.feeClaimerPda,
      d.supplyBase.toString(),
      d.founderAllocBase.toString(),
      d.levyAllocBase.toString(),
      d.treasuryAllocBase.toString(),
    ],
  );
  return res.rows[0] ? rowToToken(res.rows[0]) : null;
}

// Phase 4: the permanent-LP proof (the graduated DAMM v2 pool), once, and only
// for a token that actually launched on a curve.
export async function recordLpLock(
  db: Queryable,
  realmId: number,
  address: string,
): Promise<RealmToken | null> {
  const res = await db.query(
    `UPDATE realm_tokens SET lp_lock_address = $2, updated_at = now()
      WHERE realm_id = $1 AND lp_lock_address IS NULL AND pool_address IS NOT NULL
      RETURNING ${TOKEN_COLS}`,
    [realmId, address],
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
    recordMintCreated: (realmId, mint, launchTxSig) =>
      recordMintCreated(pool, realmId, mint, launchTxSig),
    recordDistribution: (realmId, d) => recordDistribution(pool, realmId, d),
    recordLockAddress: (realmId, bucket, address) =>
      recordLockAddress(pool, realmId, bucket, address),
    recordCurveLaunch: (realmId, d) => recordCurveLaunch(pool, realmId, d),
    recordLpLock: (realmId, address) => recordLpLock(pool, realmId, address),
  };
}
