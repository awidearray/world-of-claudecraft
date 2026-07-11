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
import type { AllocationBps } from './realm_token_alloc';
import type { RealmTokenLaunch, RealmTokenLaunchStore } from './realm_token_mint';

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

-- Launch pipeline state (launchpad phase 3): the pinned mint address, supply,
-- allocation snapshot, lock recipients, and the verification stamps. One row
-- per realm token; re-prepared freely (fresh pending_mint) until the mint is
-- confirmed, immutable after. supply_base is NUMERIC so an env-tuned supply
-- can exceed BIGINT headroom without truncation.
CREATE TABLE IF NOT EXISTS realm_token_launches (
  realm_id BIGINT PRIMARY KEY REFERENCES realms(realm_id) ON DELETE CASCADE,
  pending_mint TEXT NOT NULL UNIQUE,
  supply_base NUMERIC(30, 0) NOT NULL,
  alloc_public_bps INT NOT NULL,
  alloc_liquidity_bps INT NOT NULL,
  alloc_founder_bps INT NOT NULL,
  alloc_levy_bps INT NOT NULL,
  alloc_treasury_bps INT NOT NULL,
  founder_wallet TEXT NOT NULL,
  levy_wallet TEXT NOT NULL,
  treasury_wallet TEXT NOT NULL,
  founder_lock_address TEXT,
  levy_lock_address TEXT,
  treasury_lock_address TEXT,
  mint_confirmed_at TIMESTAMPTZ,
  locks_verified_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
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

// ── Launch pipeline persistence (phase 3) ────────────────────────────────────

const LAUNCH_COLS = `realm_id, pending_mint, supply_base,
  alloc_public_bps, alloc_liquidity_bps, alloc_founder_bps, alloc_levy_bps, alloc_treasury_bps,
  founder_wallet, levy_wallet, treasury_wallet,
  founder_lock_address, levy_lock_address, treasury_lock_address,
  mint_confirmed_at, locks_verified_at, created_at, updated_at`;

function rowToLaunch(r: Record<string, unknown>): RealmTokenLaunch {
  const alloc: AllocationBps = {
    publicBps: Number(r.alloc_public_bps),
    liquidityBps: Number(r.alloc_liquidity_bps),
    founderBps: Number(r.alloc_founder_bps),
    levyBps: Number(r.alloc_levy_bps),
    treasuryBps: Number(r.alloc_treasury_bps),
  };
  return {
    realmId: Number(r.realm_id),
    pendingMint: String(r.pending_mint),
    supplyBase: BigInt(String(r.supply_base)),
    alloc,
    founderWallet: String(r.founder_wallet),
    levyWallet: String(r.levy_wallet),
    treasuryWallet: String(r.treasury_wallet),
    founderLockAddress: r.founder_lock_address == null ? null : String(r.founder_lock_address),
    levyLockAddress: r.levy_lock_address == null ? null : String(r.levy_lock_address),
    treasuryLockAddress: r.treasury_lock_address == null ? null : String(r.treasury_lock_address),
    mintConfirmedAt: (r.mint_confirmed_at as Date | null) ?? null,
    locksVerifiedAt: (r.locks_verified_at as Date | null) ?? null,
    createdAt: r.created_at as Date,
    updatedAt: r.updated_at as Date,
  };
}

export async function getLaunch(db: Queryable, realmId: number): Promise<RealmTokenLaunch | null> {
  const res = await db.query(
    `SELECT ${LAUNCH_COLS} FROM realm_token_launches WHERE realm_id = $1`,
    [realmId],
  );
  return res.rows[0] ? rowToLaunch(res.rows[0]) : null;
}

// Insert or replace the pending launch. The WHERE guard on the upsert makes a
// confirmed launch immutable: once mint_confirmed_at is set, re-preparing
// matches no row and returns false.
export async function upsertPendingLaunch(
  db: Queryable,
  l: {
    realmId: number;
    pendingMint: string;
    supplyBase: bigint;
    alloc: AllocationBps;
    founderWallet: string;
    levyWallet: string;
    treasuryWallet: string;
  },
): Promise<boolean> {
  const res = await db.query(
    `INSERT INTO realm_token_launches
       (realm_id, pending_mint, supply_base,
        alloc_public_bps, alloc_liquidity_bps, alloc_founder_bps, alloc_levy_bps,
        alloc_treasury_bps, founder_wallet, levy_wallet, treasury_wallet)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
     ON CONFLICT (realm_id) DO UPDATE SET
       pending_mint = EXCLUDED.pending_mint,
       supply_base = EXCLUDED.supply_base,
       alloc_public_bps = EXCLUDED.alloc_public_bps,
       alloc_liquidity_bps = EXCLUDED.alloc_liquidity_bps,
       alloc_founder_bps = EXCLUDED.alloc_founder_bps,
       alloc_levy_bps = EXCLUDED.alloc_levy_bps,
       alloc_treasury_bps = EXCLUDED.alloc_treasury_bps,
       founder_wallet = EXCLUDED.founder_wallet,
       levy_wallet = EXCLUDED.levy_wallet,
       treasury_wallet = EXCLUDED.treasury_wallet,
       updated_at = now()
     WHERE realm_token_launches.mint_confirmed_at IS NULL`,
    [
      l.realmId,
      l.pendingMint,
      l.supplyBase.toString(),
      l.alloc.publicBps,
      l.alloc.liquidityBps,
      l.alloc.founderBps,
      l.alloc.levyBps,
      l.alloc.treasuryBps,
      l.founderWallet,
      l.levyWallet,
      l.treasuryWallet,
    ],
  );
  return (res.rowCount ?? 0) > 0;
}

// Atomically record the created mint on the registry row (only while mint IS
// NULL: the CAS half) and stamp the launch confirmed, in one transaction. A
// replayed launch signature or reused mint address violates the realm_tokens
// UNIQUE constraints and propagates as 23505 for the logic to map.
export async function recordMintCreated(
  pool: Pool,
  realmId: number,
  mint: string,
  launchTxSig: string,
): Promise<boolean> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const tokenRes = await client.query(
      `UPDATE realm_tokens SET mint = $2, launch_tx_sig = $3, updated_at = now()
        WHERE realm_id = $1 AND mint IS NULL`,
      [realmId, mint, launchTxSig],
    );
    if ((tokenRes.rowCount ?? 0) === 0) {
      await client.query('ROLLBACK');
      return false;
    }
    const launchRes = await client.query(
      `UPDATE realm_token_launches SET mint_confirmed_at = now(), updated_at = now()
        WHERE realm_id = $1 AND pending_mint = $2 AND mint_confirmed_at IS NULL`,
      [realmId, mint],
    );
    if ((launchRes.rowCount ?? 0) === 0) {
      await client.query('ROLLBACK');
      return false;
    }
    await client.query('COMMIT');
    return true;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

// Pin the three lock escrow addresses: only after the mint confirm and before
// the locks are verified (verified locks are immutable proof links).
export async function setLockAddresses(
  db: Queryable,
  realmId: number,
  locks: { founder: string; levy: string; treasury: string },
): Promise<boolean> {
  const res = await db.query(
    `UPDATE realm_token_launches
        SET founder_lock_address = $2, levy_lock_address = $3, treasury_lock_address = $4,
            updated_at = now()
      WHERE realm_id = $1 AND mint_confirmed_at IS NOT NULL AND locks_verified_at IS NULL`,
    [realmId, locks.founder, locks.levy, locks.treasury],
  );
  return (res.rowCount ?? 0) > 0;
}

export async function markLocksVerified(db: Queryable, realmId: number): Promise<boolean> {
  const res = await db.query(
    `UPDATE realm_token_launches SET locks_verified_at = now(), updated_at = now()
      WHERE realm_id = $1 AND mint_confirmed_at IS NOT NULL AND locks_verified_at IS NULL`,
    [realmId],
  );
  return (res.rowCount ?? 0) > 0;
}

// ── Levy fund registry reads (phase 6) ───────────────────────────────────────

// Every realm token with a created mint, for joining fund wallet balances.
export async function listTokensWithMint(db: Queryable): Promise<
  Array<{
    realmId: number;
    mint: string;
    symbol: string;
    decimals: number;
    status: string;
    curveAddress: string | null;
  }>
> {
  const res = await db.query(
    `SELECT realm_id, mint, symbol, decimals, status, curve_address
       FROM realm_tokens WHERE mint IS NOT NULL`,
  );
  return res.rows.map((r: Record<string, unknown>) => ({
    realmId: Number(r.realm_id),
    mint: String(r.mint),
    symbol: String(r.symbol),
    decimals: Number(r.decimals),
    status: String(r.status),
    curveAddress: r.curve_address == null ? null : String(r.curve_address),
  }));
}

// The verified levy locks: each phase 3 launch whose locks passed on-chain
// verification contributes its levy bucket (supply * levy bps, floored, the
// exact splitSupplyBase share) as a LOCKED fund position.
export async function listVerifiedLevyLocks(db: Queryable): Promise<
  Array<{
    realmId: number;
    mint: string;
    symbol: string;
    decimals: number;
    status: string;
    curveAddress: string | null;
    levyBase: bigint;
  }>
> {
  const res = await db.query(
    `SELECT t.realm_id, t.mint, t.symbol, t.decimals, t.status, t.curve_address,
            div(l.supply_base * l.alloc_levy_bps, 10000) AS levy_base
       FROM realm_token_launches l
       JOIN realm_tokens t ON t.realm_id = l.realm_id
      WHERE l.locks_verified_at IS NOT NULL AND t.mint IS NOT NULL`,
  );
  return res.rows.map((r: Record<string, unknown>) => ({
    realmId: Number(r.realm_id),
    mint: String(r.mint),
    symbol: String(r.symbol),
    decimals: Number(r.decimals),
    status: String(r.status),
    curveAddress: r.curve_address == null ? null : String(r.curve_address),
    levyBase: BigInt(String(r.levy_base)),
  }));
}

// ── Curve listing + graduation (phase 4) ─────────────────────────────────────

// Bind the curve to the token at listing: sets the mint (when the host created
// it, i.e. the DBC path; a phase 3 pre-set mint must match), the curve pool,
// and the per-realm fee-claimer PDA. Guarded on "no curve yet" so a double
// confirm matches nothing; a mint reused across realms violates the UNIQUE.
export async function recordCurveListed(
  db: Queryable,
  realmId: number,
  fields: { mint: string; curveAddress: string; feeClaimerPda: string },
): Promise<boolean> {
  const res = await db.query(
    `UPDATE realm_tokens
        SET mint = $2, curve_address = $3, fee_claimer_pda = $4, updated_at = now()
      WHERE realm_id = $1 AND curve_address IS NULL AND status = 'funded'
        AND (mint IS NULL OR mint = $2)`,
    [realmId, fields.mint, fields.curveAddress, fields.feeClaimerPda],
  );
  return (res.rowCount ?? 0) > 0;
}

// Record a verified graduation: the DAMM v2 pool + the permanent-lock proof
// address, flipping live -> graduated in the same guarded statement.
export async function recordGraduation(
  db: Queryable,
  realmId: number,
  fields: { poolAddress: string; lpLockAddress: string },
): Promise<RealmToken | null> {
  const res = await db.query(
    `UPDATE realm_tokens
        SET pool_address = $2, lp_lock_address = $3, status = 'graduated', updated_at = now()
      WHERE realm_id = $1 AND status = 'live'
      RETURNING ${TOKEN_COLS}`,
    [realmId, fields.poolAddress, fields.lpLockAddress],
  );
  return res.rows[0] ? rowToToken(res.rows[0]) : null;
}

// The pool-bound RealmTokenLaunchStore the routes use; tests substitute an
// in-memory fake implementing the interface from realm_token_mint.ts.
export function realmTokenLaunchStore(pool: Pool): RealmTokenLaunchStore {
  return {
    getLaunch: (realmId) => getLaunch(pool, realmId),
    upsertPendingLaunch: (l) => upsertPendingLaunch(pool, l),
    recordMintCreated: (realmId, mint, sig) => recordMintCreated(pool, realmId, mint, sig),
    setLockAddresses: (realmId, locks) => setLockAddresses(pool, realmId, locks),
    markLocksVerified: (realmId) => markLocksVerified(pool, realmId),
  };
}
