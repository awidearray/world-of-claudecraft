// Postgres persistence for the per-realm fee revenue split (launchpad phase
// 5). Two tables, both money tables, both ledger-first with UNIQUE tx-sig
// replay guards:
//
//   realm_fee_accruals       one row per VERIFIED fee-claim transaction that
//                            landed in the keeper vault (the ops multisig
//                            claims each pool's DBC partner fees with the
//                            vault as receiver; the internal route verifies
//                            the finalized claim and records it here). The
//                            accrued-minus-distributed balance is what the
//                            keeper may spend per realm, so per-realm
//                            attribution is exact even though the vault is
//                            shared.
//   realm_fee_distributions  one row per drain batch: the four split legs
//                            (operator / treasury / affiliate / burn) with a
//                            UNIQUE signature column per leg, written BEFORE
//                            each broadcast, so recovery resolves by recorded
//                            signature and can never double-pay a leg.
//
// The no-double-spend guard is a Postgres advisory TRY-lock per realm
// (withRealmFeeLock): two keeper processes cannot drain the same realm
// concurrently; the loser skips and retries next cycle. SQL lives only here;
// the keeper logic talks to the RealmFeeStore interface.

import type { Pool, PoolClient } from 'pg';
import { pool } from './db';
import type {
  FeeDistributionLeg,
  FeeDistributionRow,
  FeeVaultCurrency,
  RealmFeeStore,
} from './realm_fee_keeper';

type Queryable = Pick<Pool, 'query'> | PoolClient;

export const REALM_FEE_SCHEMA = `
CREATE TABLE IF NOT EXISTS realm_fee_accruals (
  accrual_id BIGSERIAL PRIMARY KEY,
  realm_id BIGINT NOT NULL REFERENCES realms(realm_id) ON DELETE CASCADE,
  currency TEXT NOT NULL CHECK (currency IN ('SOL', 'USDC')),
  amount_base NUMERIC(30, 0) NOT NULL CHECK (amount_base > 0),
  claim_tx_sig TEXT NOT NULL UNIQUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS realm_fee_accruals_realm ON realm_fee_accruals(realm_id, currency);

CREATE TABLE IF NOT EXISTS realm_fee_distributions (
  distribution_id BIGSERIAL PRIMARY KEY,
  realm_id BIGINT NOT NULL REFERENCES realms(realm_id) ON DELETE CASCADE,
  currency TEXT NOT NULL CHECK (currency IN ('SOL', 'USDC')),
  total_base NUMERIC(30, 0) NOT NULL CHECK (total_base > 0),
  operator_base NUMERIC(30, 0) NOT NULL,
  treasury_base NUMERIC(30, 0) NOT NULL,
  affiliate_base NUMERIC(30, 0) NOT NULL,
  burn_base NUMERIC(30, 0) NOT NULL,
  operator_wallet TEXT NOT NULL,
  treasury_wallet TEXT NOT NULL,
  affiliate_wallet TEXT,
  burn_dest TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'paying' CHECK (status IN ('paying', 'paid', 'failed')),
  operator_tx_sig TEXT UNIQUE,
  treasury_tx_sig TEXT UNIQUE,
  affiliate_tx_sig TEXT UNIQUE,
  burn_tx_sig TEXT UNIQUE,
  operator_paid BOOLEAN NOT NULL DEFAULT false,
  treasury_paid BOOLEAN NOT NULL DEFAULT false,
  affiliate_paid BOOLEAN NOT NULL DEFAULT false,
  burn_paid BOOLEAN NOT NULL DEFAULT false,
  reason TEXT,
  last_broadcast_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS realm_fee_distributions_open
  ON realm_fee_distributions(realm_id, currency) WHERE status = 'paying';
`;

const DIST_COLS = `distribution_id, realm_id, currency, total_base, operator_base, treasury_base,
  affiliate_base, burn_base, operator_wallet, treasury_wallet, affiliate_wallet, burn_dest,
  status, operator_tx_sig, treasury_tx_sig, affiliate_tx_sig, burn_tx_sig,
  operator_paid, treasury_paid, affiliate_paid, burn_paid, reason, last_broadcast_at, created_at`;

function toRow(r: Record<string, unknown>): FeeDistributionRow {
  return {
    distributionId: Number(r.distribution_id),
    realmId: Number(r.realm_id),
    currency: String(r.currency) as FeeVaultCurrency,
    totalBase: BigInt(String(r.total_base)),
    operatorBase: BigInt(String(r.operator_base)),
    treasuryBase: BigInt(String(r.treasury_base)),
    affiliateBase: BigInt(String(r.affiliate_base)),
    burnBase: BigInt(String(r.burn_base)),
    operatorWallet: String(r.operator_wallet),
    treasuryWallet: String(r.treasury_wallet),
    affiliateWallet: r.affiliate_wallet == null ? null : String(r.affiliate_wallet),
    burnDest: String(r.burn_dest),
    status: String(r.status) as FeeDistributionRow['status'],
    legSigs: {
      operator: r.operator_tx_sig == null ? null : String(r.operator_tx_sig),
      treasury: r.treasury_tx_sig == null ? null : String(r.treasury_tx_sig),
      affiliate: r.affiliate_tx_sig == null ? null : String(r.affiliate_tx_sig),
      burn: r.burn_tx_sig == null ? null : String(r.burn_tx_sig),
    },
    legPaid: {
      operator: Boolean(r.operator_paid),
      treasury: Boolean(r.treasury_paid),
      affiliate: Boolean(r.affiliate_paid),
      burn: Boolean(r.burn_paid),
    },
    lastBroadcastAt: r.last_broadcast_at == null ? null : (r.last_broadcast_at as Date),
    createdAt: r.created_at as Date,
  };
}

// The four leg columns, resolved from a closed map (never interpolated input).
const LEG_SIG_COLUMNS: Record<FeeDistributionLeg, string> = {
  operator: 'operator_tx_sig',
  treasury: 'treasury_tx_sig',
  affiliate: 'affiliate_tx_sig',
  burn: 'burn_tx_sig',
};
const LEG_PAID_COLUMNS: Record<FeeDistributionLeg, string> = {
  operator: 'operator_paid',
  treasury: 'treasury_paid',
  affiliate: 'affiliate_paid',
  burn: 'burn_paid',
};

export async function insertFeeAccrual(
  db: Queryable,
  a: { realmId: number; currency: FeeVaultCurrency; amountBase: bigint; claimTxSig: string },
): Promise<boolean> {
  const res = await db.query(
    `INSERT INTO realm_fee_accruals (realm_id, currency, amount_base, claim_tx_sig)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (claim_tx_sig) DO NOTHING`,
    [a.realmId, a.currency, a.amountBase.toString(), a.claimTxSig],
  );
  return (res.rowCount ?? 0) > 0;
}

// The realm's spendable balance: verified claim accruals minus every
// distribution ever cut (paying rows count in full: their legs are committed).
export async function unspentAccruedBase(
  db: Queryable,
  realmId: number,
  currency: FeeVaultCurrency,
): Promise<bigint> {
  const res = await db.query(
    `SELECT
       COALESCE((SELECT sum(amount_base) FROM realm_fee_accruals
                  WHERE realm_id = $1 AND currency = $2), 0)
     - COALESCE((SELECT sum(total_base) FROM realm_fee_distributions
                  WHERE realm_id = $1 AND currency = $2 AND status <> 'failed'), 0) AS unspent`,
    [realmId, currency],
  );
  const v = BigInt(String(res.rows[0].unspent));
  return v > 0n ? v : 0n;
}

export async function createFeeDistribution(
  db: Queryable,
  d: {
    realmId: number;
    currency: FeeVaultCurrency;
    totalBase: bigint;
    operatorBase: bigint;
    treasuryBase: bigint;
    affiliateBase: bigint;
    burnBase: bigint;
    operatorWallet: string;
    treasuryWallet: string;
    affiliateWallet: string | null;
    burnDest: string;
  },
): Promise<number> {
  const res = await db.query(
    `INSERT INTO realm_fee_distributions
       (realm_id, currency, total_base, operator_base, treasury_base, affiliate_base, burn_base,
        operator_wallet, treasury_wallet, affiliate_wallet, burn_dest)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
     RETURNING distribution_id`,
    [
      d.realmId,
      d.currency,
      d.totalBase.toString(),
      d.operatorBase.toString(),
      d.treasuryBase.toString(),
      d.affiliateBase.toString(),
      d.burnBase.toString(),
      d.operatorWallet,
      d.treasuryWallet,
      d.affiliateWallet,
      d.burnDest,
    ],
  );
  return Number(res.rows[0].distribution_id);
}

export async function openFeeDistribution(
  db: Queryable,
  realmId: number,
  currency: FeeVaultCurrency,
): Promise<FeeDistributionRow | null> {
  const res = await db.query(
    `SELECT ${DIST_COLS} FROM realm_fee_distributions
      WHERE realm_id = $1 AND currency = $2 AND status = 'paying'
      ORDER BY distribution_id LIMIT 1`,
    [realmId, currency],
  );
  return res.rows[0] ? toRow(res.rows[0]) : null;
}

// Record a leg's signature BEFORE broadcast (recovery resolves by it). A
// re-issue after a reverted or expired broadcast overwrites the column.
export async function recordFeeLegSig(
  db: Queryable,
  distributionId: number,
  leg: FeeDistributionLeg,
  signature: string,
): Promise<void> {
  await db.query(
    `UPDATE realm_fee_distributions
        SET ${LEG_SIG_COLUMNS[leg]} = $2, last_broadcast_at = now(), updated_at = now()
      WHERE distribution_id = $1`,
    [distributionId, signature],
  );
}

export async function markFeeLegPaid(
  db: Queryable,
  distributionId: number,
  leg: FeeDistributionLeg,
): Promise<void> {
  await db.query(
    `UPDATE realm_fee_distributions SET ${LEG_PAID_COLUMNS[leg]} = true, updated_at = now()
      WHERE distribution_id = $1`,
    [distributionId],
  );
}

export async function markFeeDistributionPaid(
  db: Queryable,
  distributionId: number,
): Promise<void> {
  await db.query(
    `UPDATE realm_fee_distributions SET status = 'paid', updated_at = now()
      WHERE distribution_id = $1 AND status = 'paying'`,
    [distributionId],
  );
}

export async function markFeeDistributionFailed(
  db: Queryable,
  distributionId: number,
  reason: string,
): Promise<void> {
  await db.query(
    `UPDATE realm_fee_distributions SET status = 'failed', reason = $2, updated_at = now()
      WHERE distribution_id = $1 AND status = 'paying'`,
    [distributionId, reason],
  );
}

// Curve-launched realms the keeper serves: a pool exists and the token is not
// torn down.
export async function listFeeRealms(
  db: Queryable,
): Promise<Array<{ realmId: number; poolAddress: string; feeClaimerPda: string | null }>> {
  const res = await db.query(
    `SELECT realm_id, pool_address, fee_claimer_pda FROM realm_tokens
      WHERE pool_address IS NOT NULL AND status <> 'closed'
      ORDER BY realm_id`,
  );
  return res.rows.map((r: Record<string, unknown>) => ({
    realmId: Number(r.realm_id),
    poolAddress: String(r.pool_address),
    feeClaimerPda: r.fee_claimer_pda == null ? null : String(r.fee_claimer_pda),
  }));
}

// The advisory-lock no-double-spend guard: a per-realm TRY lock held for the
// duration of one drain. A second keeper (or a second process) skips instead
// of blocking; nothing is ever double-spent because every leg write happens
// while exactly one holder owns the realm's lock.
const REALM_FEE_LOCK_CLASS = 0x52464b; // 'RFK'

export async function withRealmFeeLock<T>(
  pgPool: Pool,
  realmId: number,
  fn: (locked: Queryable) => Promise<T>,
): Promise<T | null> {
  const client = await pgPool.connect();
  try {
    const res = await client.query('SELECT pg_try_advisory_lock($1, $2) AS locked', [
      REALM_FEE_LOCK_CLASS,
      realmId,
    ]);
    if (res.rows[0].locked !== true) return null;
    try {
      return await fn(client);
    } finally {
      await client.query('SELECT pg_advisory_unlock($1, $2)', [REALM_FEE_LOCK_CLASS, realmId]);
    }
  } finally {
    client.release();
  }
}

// The pool-bound store the keeper uses; tests substitute an in-memory fake.
export function realmFeeStore(): RealmFeeStore {
  return {
    insertAccrual: (a) => insertFeeAccrual(pool, a),
    unspentAccruedBase: (realmId, currency) => unspentAccruedBase(pool, realmId, currency),
    createDistribution: (d) => createFeeDistribution(pool, d),
    openDistribution: (realmId, currency) => openFeeDistribution(pool, realmId, currency),
    recordLegSig: (id, leg, sig) => recordFeeLegSig(pool, id, leg, sig),
    markLegPaid: (id, leg) => markFeeLegPaid(pool, id, leg),
    markPaid: (id) => markFeeDistributionPaid(pool, id),
    markFailed: (id, reason) => markFeeDistributionFailed(pool, id, reason),
    listFeeRealms: () => listFeeRealms(pool),
    withRealmFeeLock: (realmId, fn) => withRealmFeeLock(pool, realmId, () => fn()),
  };
}
