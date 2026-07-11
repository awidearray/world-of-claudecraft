// Postgres persistence for the power-realm token-to-copper credit ledger
// (launchpad phase 7). One money table, ledger-first with a UNIQUE(pay_tx_sig)
// replay guard: the row IS the record that a given on-chain transfer was
// converted to copper, so the same signature can never credit twice. SQL lives
// only here; the logic talks to the RealmPowerCreditStore interface.

import type { Pool, PoolClient } from 'pg';
import { pool } from './db';
import type { PowerCreditStore } from './realm_power_credit';

type Queryable = Pick<Pool, 'query'> | PoolClient;

export const REALM_POWER_CREDIT_SCHEMA = `
CREATE TABLE IF NOT EXISTS realm_power_credits (
  credit_id BIGSERIAL PRIMARY KEY,
  realm_id BIGINT NOT NULL REFERENCES realms(realm_id) ON DELETE CASCADE,
  account_id INT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  wallet TEXT NOT NULL,
  token_base NUMERIC(40, 0) NOT NULL CHECK (token_base > 0),
  copper BIGINT NOT NULL CHECK (copper > 0),
  pay_tx_sig TEXT NOT NULL UNIQUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS realm_power_credits_account ON realm_power_credits(account_id);
`;

export async function recordPowerCredit(
  db: Queryable,
  c: {
    realmId: number;
    accountId: number;
    wallet: string;
    tokenBase: bigint;
    copper: number;
    payTxSig: string;
  },
): Promise<boolean> {
  const res = await db.query(
    `INSERT INTO realm_power_credits (realm_id, account_id, wallet, token_base, copper, pay_tx_sig)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (pay_tx_sig) DO NOTHING`,
    [c.realmId, c.accountId, c.wallet, c.tokenBase.toString(), c.copper, c.payTxSig],
  );
  return (res.rowCount ?? 0) > 0;
}

export function realmPowerCreditStore(): PowerCreditStore {
  return {
    recordCredit: (c) => recordPowerCredit(pool, c),
  };
}
