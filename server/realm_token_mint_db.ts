// Postgres persistence for the launch-flow quotes (launchpad phase 3). A
// launch quote pins one server-built transaction's facts (the mint pubkey, the
// exact bucket amounts, a lock's escrow address + vesting params) between the
// quote and confirm calls, exactly like the presale quote table. The payload
// is JSONB and NEVER carries key material: the transient mint/base keypairs
// sign at build time and are discarded (a stored quote could not re-sign
// anything). SQL lives only in *_db.ts; the interface + fakes live with the
// logic in realm_token_mint.ts.

import type { Pool, PoolClient } from 'pg';
import type { LaunchQuoteKind, LaunchQuoteRow, LaunchQuoteStore } from './realm_token_mint';

type Queryable = Pick<Pool, 'query'> | PoolClient;

export const REALM_LAUNCH_QUOTE_SCHEMA = `
-- Launch-flow quotes (launchpad phase 3): one row per server-built mint /
-- distribute / lock transaction awaiting its on-chain confirmation. Expired
-- rows are pruned opportunistically at each create.
CREATE TABLE IF NOT EXISTS realm_launch_quotes (
  quote_id TEXT PRIMARY KEY,
  realm_id BIGINT NOT NULL REFERENCES realms(realm_id) ON DELETE CASCADE,
  account_id INT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('mint', 'distribute', 'lock', 'curve', 'leftover')),
  payload JSONB NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS realm_launch_quotes_realm ON realm_launch_quotes(realm_id);
CREATE INDEX IF NOT EXISTS realm_launch_quotes_expires ON realm_launch_quotes(expires_at);
-- Phase 4 widened the kind vocabulary (curve launch + leftover withdrawal);
-- rebuild the CHECK for databases created on the phase-3 shape.
ALTER TABLE realm_launch_quotes DROP CONSTRAINT IF EXISTS realm_launch_quotes_kind_check;
ALTER TABLE realm_launch_quotes ADD CONSTRAINT realm_launch_quotes_kind_check
  CHECK (kind IN ('mint', 'distribute', 'lock', 'curve', 'leftover'));
`;

function toRow(r: Record<string, unknown>): LaunchQuoteRow {
  return {
    quoteId: String(r.quote_id),
    realmId: Number(r.realm_id),
    accountId: Number(r.account_id),
    kind: String(r.kind) as LaunchQuoteKind,
    payload: r.payload as Record<string, unknown>,
    expiresAt: r.expires_at as Date,
  };
}

export async function createLaunchQuote(db: Queryable, q: LaunchQuoteRow): Promise<void> {
  await db.query('DELETE FROM realm_launch_quotes WHERE expires_at < now()');
  await db.query(
    `INSERT INTO realm_launch_quotes (quote_id, realm_id, account_id, kind, payload, expires_at)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [q.quoteId, q.realmId, q.accountId, q.kind, JSON.stringify(q.payload), q.expiresAt],
  );
}

export async function getLaunchQuote(
  db: Queryable,
  quoteId: string,
): Promise<LaunchQuoteRow | null> {
  const res = await db.query(
    `SELECT quote_id, realm_id, account_id, kind, payload, expires_at
       FROM realm_launch_quotes WHERE quote_id = $1`,
    [quoteId],
  );
  return res.rows[0] ? toRow(res.rows[0]) : null;
}

export async function deleteLaunchQuote(db: Queryable, quoteId: string): Promise<void> {
  await db.query('DELETE FROM realm_launch_quotes WHERE quote_id = $1', [quoteId]);
}

export function launchQuoteStore(pool: Queryable): LaunchQuoteStore {
  return {
    createQuote: (q) => createLaunchQuote(pool, q),
    getQuote: (quoteId) => getLaunchQuote(pool, quoteId),
    deleteQuote: (quoteId) => deleteLaunchQuote(pool, quoteId),
  };
}
