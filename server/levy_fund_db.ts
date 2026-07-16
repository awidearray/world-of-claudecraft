// Postgres persistence for the Levy Street Fund (launchpad phase 6). Two
// tables, both DISPLAY-ONLY caches the valuation keeper writes and the public
// portfolio page reads (the page never touches the chain, so it is fast and
// rate-limit-safe):
//
//   levy_fund_snapshots   one row per refresh: the AUM totals (USD + SOL), the
//                         holding count, the clamp flag, and a snapshot id the
//                         holdings rows reference. The page reads the latest.
//   levy_fund_holdings    one row per (snapshot, mint): amount, price, value,
//                         weight, source tag, illiquid flag, note.
//
// Plus a rolling `levy_fund_marks` series (per-mint recent USD marks) the
// keeper reads to compute the rolling median. SQL lives only here.
//
// There is NO fund-share token table, NO redemption ledger, NO position table:
// this is a treasury we DISPLAY, not a fund we sell (PRD section 8). The
// absence is deliberate and load-bearing.

import type { Pool, PoolClient } from 'pg';
import { pool } from './db';
import type { LevyFundStore, LevyHoldingRow, LevySnapshot } from './levy_fund';

type Queryable = Pick<Pool, 'query'> | PoolClient;

export const LEVY_FUND_SCHEMA = `
CREATE TABLE IF NOT EXISTS levy_fund_snapshots (
  snapshot_id BIGSERIAL PRIMARY KEY,
  aum_usd DOUBLE PRECISION NOT NULL,
  aum_sol DOUBLE PRECISION,
  holding_count INT NOT NULL,
  included_count INT NOT NULL,
  clamped BOOLEAN NOT NULL DEFAULT false,
  sol_usd DOUBLE PRECISION,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS levy_fund_snapshots_recent ON levy_fund_snapshots(created_at DESC);

CREATE TABLE IF NOT EXISTS levy_fund_holdings (
  holding_id BIGSERIAL PRIMARY KEY,
  snapshot_id BIGINT NOT NULL REFERENCES levy_fund_snapshots(snapshot_id) ON DELETE CASCADE,
  realm_id BIGINT NOT NULL,
  mint TEXT NOT NULL,
  symbol TEXT NOT NULL,
  amount_base NUMERIC(40, 0) NOT NULL,
  decimals SMALLINT NOT NULL,
  price_usd DOUBLE PRECISION,
  value_usd DOUBLE PRECISION,
  value_sol DOUBLE PRECISION,
  weight_bps INT NOT NULL DEFAULT 0,
  source TEXT NOT NULL,
  illiquid BOOLEAN NOT NULL DEFAULT false,
  note TEXT,
  lock_address TEXT
);
CREATE INDEX IF NOT EXISTS levy_fund_holdings_snapshot ON levy_fund_holdings(snapshot_id);

-- Rolling per-mint USD marks for the median (bounded, oldest pruned).
CREATE TABLE IF NOT EXISTS levy_fund_marks (
  mark_id BIGSERIAL PRIMARY KEY,
  mint TEXT NOT NULL,
  price_usd DOUBLE PRECISION NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS levy_fund_marks_mint ON levy_fund_marks(mint, created_at DESC);
`;

// ── Snapshot writes ───────────────────────────────────────────────────────────

export async function insertSnapshot(
  db: Queryable,
  s: {
    aumUsd: number;
    aumSol: number | null;
    holdingCount: number;
    includedCount: number;
    clamped: boolean;
    solUsd: number | null;
    holdings: LevyHoldingRow[];
  },
): Promise<number> {
  const snap = await db.query(
    `INSERT INTO levy_fund_snapshots
       (aum_usd, aum_sol, holding_count, included_count, clamped, sol_usd)
     VALUES ($1, $2, $3, $4, $5, $6) RETURNING snapshot_id`,
    [s.aumUsd, s.aumSol, s.holdingCount, s.includedCount, s.clamped, s.solUsd],
  );
  const snapshotId = Number(snap.rows[0].snapshot_id);
  for (const h of s.holdings) {
    await db.query(
      `INSERT INTO levy_fund_holdings
         (snapshot_id, realm_id, mint, symbol, amount_base, decimals, price_usd, value_usd,
          value_sol, weight_bps, source, illiquid, note, lock_address)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)`,
      [
        snapshotId,
        h.realmId,
        h.mint,
        h.symbol,
        h.amountBase.toString(),
        h.decimals,
        h.priceUsd,
        h.valueUsd,
        h.valueSol,
        h.weightBps,
        h.source,
        h.illiquid,
        h.note,
        h.lockAddress,
      ],
    );
  }
  return snapshotId;
}

function rowToHolding(r: Record<string, unknown>): LevyHoldingRow {
  return {
    realmId: Number(r.realm_id),
    mint: String(r.mint),
    symbol: String(r.symbol),
    amountBase: BigInt(String(r.amount_base)),
    decimals: Number(r.decimals),
    priceUsd: r.price_usd == null ? null : Number(r.price_usd),
    valueUsd: r.value_usd == null ? null : Number(r.value_usd),
    valueSol: r.value_sol == null ? null : Number(r.value_sol),
    weightBps: Number(r.weight_bps),
    source: String(r.source),
    illiquid: Boolean(r.illiquid),
    note: r.note == null ? null : String(r.note),
    lockAddress: r.lock_address == null ? null : String(r.lock_address),
  };
}

export async function latestSnapshot(db: Queryable): Promise<LevySnapshot | null> {
  const snap = await db.query(
    `SELECT snapshot_id, aum_usd, aum_sol, holding_count, included_count, clamped, sol_usd, created_at
       FROM levy_fund_snapshots ORDER BY snapshot_id DESC LIMIT 1`,
  );
  if (!snap.rows[0]) return null;
  const s = snap.rows[0];
  const snapshotId = Number(s.snapshot_id);
  const holdings = await db.query(
    `SELECT ${HOLDING_COLS} FROM levy_fund_holdings WHERE snapshot_id = $1
      ORDER BY value_usd DESC NULLS LAST, symbol`,
    [snapshotId],
  );
  return {
    snapshotId,
    aumUsd: Number(s.aum_usd),
    aumSol: s.aum_sol == null ? null : Number(s.aum_sol),
    holdingCount: Number(s.holding_count),
    includedCount: Number(s.included_count),
    clamped: Boolean(s.clamped),
    solUsd: s.sol_usd == null ? null : Number(s.sol_usd),
    createdAt: s.created_at as Date,
    holdings: holdings.rows.map(rowToHolding),
  };
}

const HOLDING_COLS = `realm_id, mint, symbol, amount_base, decimals, price_usd, value_usd,
  value_sol, weight_bps, source, illiquid, note, lock_address`;

// The AUM of the immediately-previous snapshot (for the clamp).
export async function previousAum(db: Queryable): Promise<number | null> {
  const res = await db.query(
    'SELECT aum_usd FROM levy_fund_snapshots ORDER BY snapshot_id DESC LIMIT 1',
  );
  return res.rows[0] ? Number(res.rows[0].aum_usd) : null;
}

// ── Rolling marks ─────────────────────────────────────────────────────────────

export async function recentMarks(db: Queryable, mint: string, window: number): Promise<number[]> {
  const res = await db.query(
    `SELECT price_usd FROM levy_fund_marks WHERE mint = $1 ORDER BY created_at DESC LIMIT $2`,
    [mint, window],
  );
  // Return oldest-first for rollingMedianUsd.
  return res.rows.map((r: Record<string, unknown>) => Number(r.price_usd)).reverse();
}

export async function insertMark(db: Queryable, mint: string, priceUsd: number): Promise<void> {
  await db.query('INSERT INTO levy_fund_marks (mint, price_usd) VALUES ($1, $2)', [mint, priceUsd]);
  // Prune to a bounded history per mint (keep the last 200).
  await db.query(
    `DELETE FROM levy_fund_marks WHERE mint = $1 AND mark_id NOT IN (
       SELECT mark_id FROM levy_fund_marks WHERE mint = $1 ORDER BY created_at DESC LIMIT 200)`,
    [mint],
  );
}

// The realm tokens the fund holds a levy allocation of: launched tokens with a
// recorded levy allocation. Locked or not, the fund's economic slice is the
// levy_alloc_base of every launched realm token (the daos.fun-style portfolio).
export async function levyHoldingSources(db: Queryable): Promise<
  Array<{
    realmId: number;
    mint: string;
    symbol: string;
    decimals: number;
    levyAllocBase: bigint;
    poolAddress: string | null;
    status: string;
    levyLockAddress: string | null;
  }>
> {
  const res = await db.query(
    `SELECT realm_id, mint, symbol, decimals, levy_alloc_base, pool_address, status, levy_lock_address
       FROM realm_tokens
      WHERE mint IS NOT NULL AND levy_alloc_base IS NOT NULL AND levy_alloc_base > 0
        AND status IN ('live', 'graduated')
      ORDER BY realm_id`,
  );
  return res.rows.map((r: Record<string, unknown>) => ({
    realmId: Number(r.realm_id),
    mint: String(r.mint),
    symbol: String(r.symbol),
    decimals: Number(r.decimals),
    levyAllocBase: BigInt(String(r.levy_alloc_base)),
    poolAddress: r.pool_address == null ? null : String(r.pool_address),
    status: String(r.status),
    levyLockAddress: r.levy_lock_address == null ? null : String(r.levy_lock_address),
  }));
}

export function levyFundStore(): LevyFundStore {
  return {
    holdingSources: () => levyHoldingSources(pool),
    recentMarks: (mint, window) => recentMarks(pool, mint, window),
    insertMark: (mint, priceUsd) => insertMark(pool, mint, priceUsd),
    previousAum: () => previousAum(pool),
    insertSnapshot: (s) => insertSnapshot(pool, s),
    latestSnapshot: () => latestSnapshot(pool),
  };
}
