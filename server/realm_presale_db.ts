// Postgres persistence for the realm token presale (launchpad phase 2), forked
// from realm_buy_db.ts. Three tables: the per-realm presale config (the
// FOUNDER-OWNED escrow wallet + per-rail caps), the short-lived contribution
// quotes, and the permanent contribution ledger with its UNIQUE(pay_tx_sig)
// replay guard (and a UNIQUE(refund_tx_sig) guard so one refund transaction can
// never cover two rows). All amounts are base-unit bigint, read as bigint,
// never coerced to a JS number. SQL lives only here; logic (caps, verify,
// lifecycle) lives in realm_presale.ts against the RealmPresaleStore interface.

import type { Pool, PoolClient } from 'pg';
import {
  isPresaleCurrency,
  PRESALE_CURRENCIES,
  type PresaleConfig,
  type PresaleContribution,
  type PresaleCurrency,
  type PresaleQuoteRow,
  type PresaleRailCaps,
  type RealmPresaleStore,
} from './realm_presale';

type Queryable = Pick<Pool, 'query'> | PoolClient;

export const REALM_PRESALE_SCHEMA = `
-- Presale config (launchpad phase 2): one presale per realm token. The escrow
-- wallet is founder/escrow-owned (non-custodial: the server never holds a key
-- for it); each rail's caps are base units of that currency, NULL = rail off.
CREATE TABLE IF NOT EXISTS realm_presales (
  realm_id BIGINT PRIMARY KEY REFERENCES realms(realm_id) ON DELETE CASCADE,
  escrow_wallet TEXT NOT NULL,
  sol_soft_cap_base BIGINT,
  sol_raise_cap_base BIGINT,
  sol_wallet_cap_base BIGINT,
  usdc_soft_cap_base BIGINT,
  usdc_raise_cap_base BIGINT,
  usdc_wallet_cap_base BIGINT,
  woc_soft_cap_base BIGINT,
  woc_raise_cap_base BIGINT,
  woc_wallet_cap_base BIGINT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Short-lived contribution quotes (parallel to realm_buy_quotes): pins the
-- contributor's linked wallet, the rail, the exact amount, and the escrow
-- recipient; memo == quote_id binds the on-chain transfer to this quote.
CREATE TABLE IF NOT EXISTS realm_presale_quotes (
  quote_id TEXT PRIMARY KEY,
  realm_id BIGINT NOT NULL REFERENCES realms(realm_id) ON DELETE CASCADE,
  account_id INT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  wallet TEXT NOT NULL,
  currency TEXT NOT NULL CHECK (currency IN ('SOL', 'USDC', 'WOC')),
  amount_base BIGINT NOT NULL,
  escrow_addr TEXT NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS realm_presale_quotes_expires ON realm_presale_quotes(expires_at);

-- The contribution ledger. Written LEDGER-FIRST on a verified finalized
-- transaction; pay_tx_sig UNIQUE is the replay guard, refund_tx_sig UNIQUE
-- stops one escrow-signed refund from covering two contributions.
CREATE TABLE IF NOT EXISTS realm_presale_contributions (
  contribution_id BIGSERIAL PRIMARY KEY,
  realm_id BIGINT NOT NULL REFERENCES realms(realm_id) ON DELETE CASCADE,
  account_id INT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  wallet TEXT NOT NULL,
  currency TEXT NOT NULL CHECK (currency IN ('SOL', 'USDC', 'WOC')),
  amount_base BIGINT NOT NULL,
  pay_tx_sig TEXT NOT NULL UNIQUE,
  refund_tx_sig TEXT UNIQUE,
  refunded_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS realm_presale_contributions_realm
  ON realm_presale_contributions(realm_id);
CREATE INDEX IF NOT EXISTS realm_presale_contributions_wallet
  ON realm_presale_contributions(realm_id, wallet, currency);
`;

const RAIL_COLS: Record<PresaleCurrency, [string, string, string]> = {
  SOL: ['sol_soft_cap_base', 'sol_raise_cap_base', 'sol_wallet_cap_base'],
  USDC: ['usdc_soft_cap_base', 'usdc_raise_cap_base', 'usdc_wallet_cap_base'],
  WOC: ['woc_soft_cap_base', 'woc_raise_cap_base', 'woc_wallet_cap_base'],
};

function rowToPresale(r: Record<string, unknown>): PresaleConfig {
  const rails: Partial<Record<PresaleCurrency, PresaleRailCaps>> = {};
  for (const key of PRESALE_CURRENCIES) {
    const [soft, raise, wallet] = RAIL_COLS[key];
    if (r[soft] == null || r[raise] == null || r[wallet] == null) continue;
    rails[key] = {
      softCapBase: BigInt(String(r[soft])),
      raiseCapBase: BigInt(String(r[raise])),
      walletCapBase: BigInt(String(r[wallet])),
    };
  }
  return {
    realmId: Number(r.realm_id),
    escrowWallet: String(r.escrow_wallet),
    rails,
    createdAt: r.created_at as Date,
  };
}

export async function createPresale(
  db: Queryable,
  config: {
    realmId: number;
    escrowWallet: string;
    rails: Partial<Record<PresaleCurrency, PresaleRailCaps>>;
  },
): Promise<void> {
  const railValue = (key: PresaleCurrency, idx: 0 | 1 | 2): string | null => {
    const caps = config.rails[key];
    if (!caps) return null;
    return [caps.softCapBase, caps.raiseCapBase, caps.walletCapBase][idx].toString();
  };
  await db.query(
    `INSERT INTO realm_presales
       (realm_id, escrow_wallet,
        sol_soft_cap_base, sol_raise_cap_base, sol_wallet_cap_base,
        usdc_soft_cap_base, usdc_raise_cap_base, usdc_wallet_cap_base,
        woc_soft_cap_base, woc_raise_cap_base, woc_wallet_cap_base)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
    [
      config.realmId,
      config.escrowWallet,
      railValue('SOL', 0),
      railValue('SOL', 1),
      railValue('SOL', 2),
      railValue('USDC', 0),
      railValue('USDC', 1),
      railValue('USDC', 2),
      railValue('WOC', 0),
      railValue('WOC', 1),
      railValue('WOC', 2),
    ],
  );
}

export async function getPresale(db: Queryable, realmId: number): Promise<PresaleConfig | null> {
  const res = await db.query('SELECT * FROM realm_presales WHERE realm_id = $1', [realmId]);
  return res.rows[0] ? rowToPresale(res.rows[0]) : null;
}

const QUOTE_COLS =
  'quote_id, realm_id, account_id, wallet, currency, amount_base, escrow_addr, expires_at';

function rowToQuote(r: Record<string, unknown>): PresaleQuoteRow {
  const currency = String(r.currency);
  return {
    quoteId: String(r.quote_id),
    realmId: Number(r.realm_id),
    accountId: Number(r.account_id),
    wallet: String(r.wallet),
    currency: isPresaleCurrency(currency) ? currency : 'USDC',
    amountBase: BigInt(String(r.amount_base)),
    escrowAddr: String(r.escrow_addr),
    expiresAt: r.expires_at as Date,
  };
}

export async function createQuote(db: Queryable, q: PresaleQuoteRow): Promise<void> {
  await db.query(
    `INSERT INTO realm_presale_quotes
       (quote_id, realm_id, account_id, wallet, currency, amount_base, escrow_addr, expires_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
    [
      q.quoteId,
      q.realmId,
      q.accountId,
      q.wallet,
      q.currency,
      q.amountBase.toString(),
      q.escrowAddr,
      q.expiresAt,
    ],
  );
}

export async function getQuote(db: Queryable, quoteId: string): Promise<PresaleQuoteRow | null> {
  const res = await db.query(`SELECT ${QUOTE_COLS} FROM realm_presale_quotes WHERE quote_id = $1`, [
    quoteId,
  ]);
  return res.rows[0] ? rowToQuote(res.rows[0]) : null;
}

export async function deleteQuote(db: Queryable, quoteId: string): Promise<void> {
  await db.query('DELETE FROM realm_presale_quotes WHERE quote_id = $1', [quoteId]);
}

// Confirmed (unrefunded and refunded alike: a refund does not un-raise for cap
// purposes; the presale is already closed when refunds run) totals per rail.
export async function raisedByCurrency(
  db: Queryable,
  realmId: number,
): Promise<Map<PresaleCurrency, bigint>> {
  const res = await db.query(
    `SELECT currency, coalesce(sum(amount_base), 0)::text AS total
       FROM realm_presale_contributions WHERE realm_id = $1 GROUP BY currency`,
    [realmId],
  );
  const out = new Map<PresaleCurrency, bigint>();
  for (const r of res.rows as Array<Record<string, unknown>>) {
    const currency = String(r.currency);
    if (isPresaleCurrency(currency)) out.set(currency, BigInt(String(r.total)));
  }
  return out;
}

export async function contributedByWallet(
  db: Queryable,
  realmId: number,
  wallet: string,
  currency: PresaleCurrency,
): Promise<bigint> {
  const res = await db.query(
    `SELECT coalesce(sum(amount_base), 0)::text AS total
       FROM realm_presale_contributions
      WHERE realm_id = $1 AND wallet = $2 AND currency = $3`,
    [realmId, wallet, currency],
  );
  return BigInt(String(res.rows[0]?.total ?? '0'));
}

export async function insertContribution(
  db: Queryable,
  c: {
    realmId: number;
    accountId: number;
    wallet: string;
    currency: PresaleCurrency;
    amountBase: bigint;
    payTxSig: string;
  },
): Promise<void> {
  await db.query(
    `INSERT INTO realm_presale_contributions
       (realm_id, account_id, wallet, currency, amount_base, pay_tx_sig)
     VALUES ($1,$2,$3,$4,$5,$6)`,
    [c.realmId, c.accountId, c.wallet, c.currency, c.amountBase.toString(), c.payTxSig],
  );
}

const CONTRIB_COLS = `contribution_id, realm_id, account_id, wallet, currency, amount_base,
  pay_tx_sig, refund_tx_sig, refunded_at, created_at`;

function rowToContribution(r: Record<string, unknown>): PresaleContribution {
  const currency = String(r.currency);
  return {
    contributionId: Number(r.contribution_id),
    realmId: Number(r.realm_id),
    accountId: Number(r.account_id),
    wallet: String(r.wallet),
    currency: isPresaleCurrency(currency) ? currency : 'USDC',
    amountBase: BigInt(String(r.amount_base)),
    payTxSig: String(r.pay_tx_sig),
    refundTxSig: r.refund_tx_sig == null ? null : String(r.refund_tx_sig),
    refundedAt: (r.refunded_at as Date | null) ?? null,
    createdAt: r.created_at as Date,
  };
}

export async function getContributionByPaySig(
  db: Queryable,
  payTxSig: string,
): Promise<PresaleContribution | null> {
  const res = await db.query(
    `SELECT ${CONTRIB_COLS} FROM realm_presale_contributions WHERE pay_tx_sig = $1`,
    [payTxSig],
  );
  return res.rows[0] ? rowToContribution(res.rows[0]) : null;
}

export async function listContributionsForWallet(
  db: Queryable,
  realmId: number,
  wallet: string,
): Promise<PresaleContribution[]> {
  const res = await db.query(
    `SELECT ${CONTRIB_COLS} FROM realm_presale_contributions
      WHERE realm_id = $1 AND wallet = $2 ORDER BY created_at ASC, contribution_id ASC`,
    [realmId, wallet],
  );
  return res.rows.map(rowToContribution);
}

// Mark one contribution refunded (idempotence guard: only an unrefunded row
// matches). The UNIQUE(refund_tx_sig) constraint additionally rejects reusing
// one refund transaction across rows (surfaces as a 23505 the logic maps).
export async function markRefunded(
  db: Queryable,
  contributionId: number,
  refundTxSig: string,
): Promise<boolean> {
  const res = await db.query(
    `UPDATE realm_presale_contributions
        SET refund_tx_sig = $2, refunded_at = now()
      WHERE contribution_id = $1 AND refund_tx_sig IS NULL`,
    [contributionId, refundTxSig],
  );
  return (res.rowCount ?? 0) > 0;
}

export async function countUnrefunded(db: Queryable, realmId: number): Promise<number> {
  const res = await db.query(
    `SELECT count(*)::int AS n FROM realm_presale_contributions
      WHERE realm_id = $1 AND refund_tx_sig IS NULL`,
    [realmId],
  );
  return Number(res.rows[0]?.n ?? 0);
}

function storeFor(db: Queryable, pool: Pool | null): RealmPresaleStore {
  return {
    createPresale: (config) => createPresale(db, config),
    getPresale: (realmId) => getPresale(db, realmId),
    createQuote: (q) => createQuote(db, q),
    getQuote: (quoteId) => getQuote(db, quoteId),
    deleteQuote: (quoteId) => deleteQuote(db, quoteId),
    raisedByCurrency: (realmId) => raisedByCurrency(db, realmId),
    contributedByWallet: (realmId, wallet, currency) =>
      contributedByWallet(db, realmId, wallet, currency),
    insertContribution: (c) => insertContribution(db, c),
    getContributionByPaySig: (payTxSig) => getContributionByPaySig(db, payTxSig),
    listContributionsForWallet: (realmId, wallet) =>
      listContributionsForWallet(db, realmId, wallet),
    markRefunded: (contributionId, refundTxSig) => markRefunded(db, contributionId, refundTxSig),
    countUnrefunded: (realmId) => countUnrefunded(db, realmId),
    // Serialize confirms per presale: BEGIN + SELECT ... FOR UPDATE on the
    // presale row, then run the callback against a client-bound store so its
    // cap recheck + ledger insert commit (or roll back) atomically.
    async withPresaleLock<T>(
      realmId: number,
      fn: (locked: RealmPresaleStore) => Promise<T>,
    ): Promise<T> {
      if (!pool) throw new Error('withPresaleLock requires a pool-bound store');
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        await client.query('SELECT realm_id FROM realm_presales WHERE realm_id = $1 FOR UPDATE', [
          realmId,
        ]);
        const result = await fn(storeFor(client, null));
        await client.query('COMMIT');
        return result;
      } catch (err) {
        await client.query('ROLLBACK');
        throw err;
      } finally {
        client.release();
      }
    },
  };
}

// The pool-bound RealmPresaleStore the routes use; tests use an in-memory fake
// implementing the interface from realm_presale.ts.
export function realmPresaleStore(pool: Pool): RealmPresaleStore {
  return storeFor(pool, pool);
}
