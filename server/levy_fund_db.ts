// Postgres persistence for the Levy Street Fund snapshot (launchpad phase 6):
// the latest holdings snapshot the public portfolio page reads (never the
// chain), the per-mint mark history that feeds the rolling median, and the
// one-row meta carrying the published AUM. A display cache, not a money
// ledger: no grants ever derive from these rows. SQL lives only here.

import type { Pool, PoolClient } from 'pg';
import type { LevyFundSnapshot, LevyFundStore } from './levy_fund';
import type { HoldingMark } from './token_valuation';

type Queryable = Pick<Pool, 'query'> | PoolClient;

export const LEVY_FUND_SCHEMA = `
-- The latest snapshot, one row per held mint (upserted whole each refresh).
CREATE TABLE IF NOT EXISTS levy_fund_holdings (
  mint TEXT NOT NULL,
  locked BOOLEAN NOT NULL DEFAULT FALSE,
  realm_id BIGINT,
  symbol TEXT NOT NULL DEFAULT '',
  amount_base NUMERIC(30, 0) NOT NULL DEFAULT 0,
  decimals INT NOT NULL DEFAULT 9,
  graduated BOOLEAN NOT NULL DEFAULT FALSE,
  price_usd DOUBLE PRECISION,
  value_usd DOUBLE PRECISION,
  source TEXT NOT NULL DEFAULT 'none',
  confidence TEXT NOT NULL DEFAULT 'low',
  illiquid BOOLEAN NOT NULL DEFAULT TRUE,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (mint, locked)
);

-- Recent raw marks per mint (the rolling-median window); pruned on append.
CREATE TABLE IF NOT EXISTS levy_fund_marks (
  mark_id BIGSERIAL PRIMARY KEY,
  mint TEXT NOT NULL,
  price_usd DOUBLE PRECISION NOT NULL,
  at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS levy_fund_marks_mint ON levy_fund_marks(mint, at DESC);

-- The published totals (a single row, id 1).
CREATE TABLE IF NOT EXISTS levy_fund_meta (
  id INT PRIMARY KEY,
  aum_usd DOUBLE PRECISION NOT NULL DEFAULT 0,
  aum_clamped BOOLEAN NOT NULL DEFAULT FALSE,
  sol_usd DOUBLE PRECISION,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
`;

const MARK_HISTORY_KEEP = 32;

export async function saveSnapshot(
  db: Queryable,
  snapshot: {
    holdings: HoldingMark[];
    aumUsd: number;
    aumClamped: boolean;
    solUsd: number | null;
  },
): Promise<void> {
  await db.query('DELETE FROM levy_fund_holdings');
  for (const h of snapshot.holdings) {
    await db.query(
      `INSERT INTO levy_fund_holdings
         (mint, locked, realm_id, symbol, amount_base, decimals, graduated,
          price_usd, value_usd, source, confidence, illiquid, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12, now())
       ON CONFLICT (mint, locked) DO UPDATE SET
         realm_id = EXCLUDED.realm_id, symbol = EXCLUDED.symbol,
         amount_base = EXCLUDED.amount_base, decimals = EXCLUDED.decimals,
         graduated = EXCLUDED.graduated, price_usd = EXCLUDED.price_usd,
         value_usd = EXCLUDED.value_usd, source = EXCLUDED.source,
         confidence = EXCLUDED.confidence, illiquid = EXCLUDED.illiquid,
         updated_at = now()`,
      [
        h.mint,
        h.locked,
        h.realmId,
        h.symbol,
        h.amountBase.toString(),
        h.decimals,
        h.graduated,
        h.priceUsd,
        h.valueUsd,
        h.source,
        h.confidence,
        h.illiquid,
      ],
    );
  }
  await db.query(
    `INSERT INTO levy_fund_meta (id, aum_usd, aum_clamped, sol_usd, updated_at)
     VALUES (1, $1, $2, $3, now())
     ON CONFLICT (id) DO UPDATE SET
       aum_usd = EXCLUDED.aum_usd, aum_clamped = EXCLUDED.aum_clamped,
       sol_usd = EXCLUDED.sol_usd, updated_at = now()`,
    [snapshot.aumUsd, snapshot.aumClamped, snapshot.solUsd],
  );
}

export async function readSnapshot(db: Queryable): Promise<LevyFundSnapshot | null> {
  const meta = await db.query(
    'SELECT aum_usd, aum_clamped, sol_usd, updated_at FROM levy_fund_meta WHERE id = 1',
  );
  if (!meta.rows[0]) return null;
  const rows = await db.query(
    `SELECT mint, locked, realm_id, symbol, amount_base, decimals, graduated,
            price_usd, value_usd, source, confidence, illiquid
       FROM levy_fund_holdings`,
  );
  return {
    aumUsd: Number(meta.rows[0].aum_usd),
    aumClamped: Boolean(meta.rows[0].aum_clamped),
    solUsd: meta.rows[0].sol_usd == null ? null : Number(meta.rows[0].sol_usd),
    updatedAt: new Date(meta.rows[0].updated_at as string).toISOString(),
    holdings: rows.rows.map((r: Record<string, unknown>) => ({
      mint: String(r.mint),
      realmId: r.realm_id == null ? null : Number(r.realm_id),
      symbol: String(r.symbol),
      amountBase: String(r.amount_base),
      decimals: Number(r.decimals),
      locked: Boolean(r.locked),
      graduated: Boolean(r.graduated),
      priceUsd: r.price_usd == null ? null : Number(r.price_usd),
      valueUsd: r.value_usd == null ? null : Number(r.value_usd),
      weightBps: 0, // computed by portfolioView
      source: String(r.source),
      confidence: String(r.confidence),
      illiquid: Boolean(r.illiquid),
    })),
  };
}

export async function previousAumUsd(db: Queryable): Promise<number | null> {
  const res = await db.query('SELECT aum_usd FROM levy_fund_meta WHERE id = 1');
  return res.rows[0] ? Number(res.rows[0].aum_usd) : null;
}

export async function recentMarks(db: Queryable, mint: string, limit: number): Promise<number[]> {
  const res = await db.query(
    'SELECT price_usd FROM levy_fund_marks WHERE mint = $1 ORDER BY at DESC, mark_id DESC LIMIT $2',
    [mint, limit],
  );
  return res.rows.map((r: Record<string, unknown>) => Number(r.price_usd));
}

export async function appendMark(db: Queryable, mint: string, priceUsd: number): Promise<void> {
  await db.query('INSERT INTO levy_fund_marks (mint, price_usd) VALUES ($1, $2)', [mint, priceUsd]);
  await db.query(
    `DELETE FROM levy_fund_marks
      WHERE mint = $1 AND mark_id NOT IN (
        SELECT mark_id FROM levy_fund_marks WHERE mint = $1 ORDER BY at DESC, mark_id DESC LIMIT $2
      )`,
    [mint, MARK_HISTORY_KEEP],
  );
}

export function levyFundStore(db: Queryable): LevyFundStore {
  return {
    saveSnapshot: (snapshot) => saveSnapshot(db, snapshot),
    readSnapshot: () => readSnapshot(db),
    previousAumUsd: () => previousAumUsd(db),
    recentMarks: (mint, limit) => recentMarks(db, mint, limit),
    appendMark: (mint, priceUsd) => appendMark(db, mint, priceUsd),
  };
}
