// Postgres persistence for the realm-token fee keeper (launchpad phase 5): the
// realm_fee_claims ledger. Every claim is written LEDGER-FIRST before its
// transaction broadcasts (claim_tx_sig UNIQUE is the replay/recovery anchor;
// distribute_tx_sig UNIQUE stops one distribution from covering two claims),
// and the split legs are pinned on the row so recovery executes the recorded
// ledger, never a recomputation. SQL lives only here (server/CLAUDE.md); the
// orchestration in realm_fee_keeper.ts talks to the RealmFeeStore interface.

import type { Pool, PoolClient } from 'pg';
import type {
  FeeClaimRow,
  FeeClaimStatus,
  FeeSplit,
  FeeTarget,
  RealmFeeStore,
} from './realm_fee_keeper';

type Queryable = Pick<Pool, 'query'> | PoolClient;

export const REALM_FEE_SCHEMA = `
-- Realm-token fee claims (launchpad phase 5): one row per partner-fee claim,
-- ledger-first with UNIQUE signatures on both the claim and the distribution.
CREATE TABLE IF NOT EXISTS realm_fee_claims (
  claim_id TEXT PRIMARY KEY,
  realm_id BIGINT NOT NULL REFERENCES realms(realm_id) ON DELETE CASCADE,
  pool_address TEXT NOT NULL,
  quote_mint TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'claiming'
    CHECK (status IN ('claiming', 'claimed', 'distributing', 'distributed', 'failed')),
  claim_tx_sig TEXT UNIQUE,
  claimed_base NUMERIC(30, 0) NOT NULL DEFAULT 0,
  operator_wallet TEXT,
  affiliate_wallet TEXT,
  operator_base NUMERIC(30, 0) NOT NULL DEFAULT 0,
  affiliate_base NUMERIC(30, 0) NOT NULL DEFAULT 0,
  treasury_base NUMERIC(30, 0) NOT NULL DEFAULT 0,
  buyback_base NUMERIC(30, 0) NOT NULL DEFAULT 0,
  distribute_tx_sig TEXT UNIQUE,
  distribute_broadcast_at TIMESTAMPTZ,
  reason TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS realm_fee_claims_open
  ON realm_fee_claims(status) WHERE status IN ('claiming', 'claimed', 'distributing');
CREATE INDEX IF NOT EXISTS realm_fee_claims_realm ON realm_fee_claims(realm_id);
`;

const CLAIM_COLS = `claim_id, realm_id, pool_address, quote_mint, status, claim_tx_sig,
  claimed_base, operator_wallet, affiliate_wallet, operator_base, affiliate_base,
  treasury_base, buyback_base, distribute_tx_sig, distribute_broadcast_at, created_at`;

function rowToClaim(r: Record<string, unknown>): FeeClaimRow {
  return {
    claimId: String(r.claim_id),
    realmId: Number(r.realm_id),
    poolAddress: String(r.pool_address),
    quoteMint: String(r.quote_mint),
    status: String(r.status) as FeeClaimStatus,
    claimTxSig: r.claim_tx_sig == null ? null : String(r.claim_tx_sig),
    claimedBase: BigInt(String(r.claimed_base ?? '0')),
    operatorWallet: r.operator_wallet == null ? null : String(r.operator_wallet),
    affiliateWallet: r.affiliate_wallet == null ? null : String(r.affiliate_wallet),
    operatorBase: BigInt(String(r.operator_base ?? '0')),
    affiliateBase: BigInt(String(r.affiliate_base ?? '0')),
    treasuryBase: BigInt(String(r.treasury_base ?? '0')),
    buybackBase: BigInt(String(r.buyback_base ?? '0')),
    distributeTxSig: r.distribute_tx_sig == null ? null : String(r.distribute_tx_sig),
    distributeBroadcastAt: (r.distribute_broadcast_at as Date | null) ?? null,
    createdAt: r.created_at as Date,
  };
}

export async function createClaim(
  db: Queryable,
  row: {
    claimId: string;
    realmId: number;
    poolAddress: string;
    quoteMint: string;
    claimTxSig: string;
  },
): Promise<boolean> {
  const res = await db.query(
    `INSERT INTO realm_fee_claims (claim_id, realm_id, pool_address, quote_mint, claim_tx_sig)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (claim_tx_sig) DO NOTHING`,
    [row.claimId, row.realmId, row.poolAddress, row.quoteMint, row.claimTxSig],
  );
  return (res.rowCount ?? 0) > 0;
}

export async function markClaimed(
  db: Queryable,
  claimId: string,
  fields: {
    claimedBase: bigint;
    operatorWallet: string;
    affiliateWallet: string | null;
    split: FeeSplit;
  },
): Promise<void> {
  await db.query(
    `UPDATE realm_fee_claims
        SET status = 'claimed', claimed_base = $2, operator_wallet = $3, affiliate_wallet = $4,
            operator_base = $5, affiliate_base = $6, treasury_base = $7, buyback_base = $8,
            updated_at = now()
      WHERE claim_id = $1 AND status = 'claiming'`,
    [
      claimId,
      fields.claimedBase.toString(),
      fields.operatorWallet,
      fields.affiliateWallet,
      fields.split.operatorBase.toString(),
      fields.split.affiliateBase.toString(),
      fields.split.treasuryBase.toString(),
      fields.split.buybackBase.toString(),
    ],
  );
}

export async function markDistributing(
  db: Queryable,
  claimId: string,
  distributeTxSig: string,
): Promise<void> {
  await db.query(
    `UPDATE realm_fee_claims
        SET status = 'distributing', distribute_tx_sig = $2, distribute_broadcast_at = now(),
            updated_at = now()
      WHERE claim_id = $1 AND status IN ('claimed', 'distributing')`,
    [claimId, distributeTxSig],
  );
}

export async function markDistributed(db: Queryable, claimId: string): Promise<void> {
  await db.query(
    `UPDATE realm_fee_claims SET status = 'distributed', updated_at = now()
      WHERE claim_id = $1 AND status IN ('claimed', 'distributing')`,
    [claimId],
  );
}

export async function markFailed(db: Queryable, claimId: string, reason: string): Promise<void> {
  await db.query(
    `UPDATE realm_fee_claims SET status = 'failed', reason = $2, updated_at = now()
      WHERE claim_id = $1 AND status IN ('claiming', 'claimed', 'distributing')`,
    [claimId, reason],
  );
}

export async function openClaims(db: Queryable): Promise<FeeClaimRow[]> {
  const res = await db.query(
    `SELECT ${CLAIM_COLS} FROM realm_fee_claims
      WHERE status IN ('claiming', 'claimed', 'distributing')
      ORDER BY created_at ASC`,
  );
  return res.rows.map(rowToClaim);
}

// The fee targets: every live/graduated realm token trading on a curve.
export async function listFeeTargets(db: Queryable): Promise<FeeTarget[]> {
  const res = await db.query(
    `SELECT realm_id, curve_address FROM realm_tokens
      WHERE status IN ('live', 'graduated') AND curve_address IS NOT NULL`,
  );
  return res.rows.map((r: Record<string, unknown>) => ({
    realmId: Number(r.realm_id),
    poolAddress: String(r.curve_address),
  }));
}

export function realmFeeStore(db: Queryable): RealmFeeStore {
  return {
    createClaim: (row) => createClaim(db, row),
    markClaimed: (claimId, fields) => markClaimed(db, claimId, fields),
    markDistributing: (claimId, sig) => markDistributing(db, claimId, sig),
    markDistributed: (claimId) => markDistributed(db, claimId),
    markFailed: (claimId, reason) => markFailed(db, claimId, reason),
    openClaims: () => openClaims(db),
  };
}
