// Postgres persistence for power-realm token-to-copper credits (launchpad
// phase 7): short-lived quotes plus the credit ledger. Ledger-first with
// UNIQUE(pay_tx_sig); rows are born uncredited and marked credited exactly
// once when the game grants the copper (live session, or the character's next
// join), so a crash between verify and grant can never lose or double a
// credit. SQL lives only here.

import type { Pool, PoolClient } from 'pg';
import type { PowerQuoteRow, RealmPowerStore } from './realm_power';

type Queryable = Pick<Pool, 'query'> | PoolClient;

export const REALM_POWER_SCHEMA = `
-- Power-credit quotes (phase 7): pins the wallet, the exact token amount, the
-- pinned copper credit, and the treasury sink; memo == quote_id binds the
-- on-chain transfer to the quote.
CREATE TABLE IF NOT EXISTS realm_power_quotes (
  quote_id TEXT PRIMARY KEY,
  realm_id BIGINT NOT NULL REFERENCES realms(realm_id) ON DELETE CASCADE,
  account_id INT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  character_id INT NOT NULL,
  wallet TEXT NOT NULL,
  amount_base NUMERIC(30, 0) NOT NULL,
  copper_credit BIGINT NOT NULL,
  sink_wallet TEXT NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS realm_power_quotes_expires ON realm_power_quotes(expires_at);

-- The credit ledger: written LEDGER-FIRST on a verified finalized transfer.
-- credited_at NULL = banked, granted on the character's next join.
CREATE TABLE IF NOT EXISTS realm_power_credits (
  credit_id BIGSERIAL PRIMARY KEY,
  realm_id BIGINT NOT NULL REFERENCES realms(realm_id) ON DELETE CASCADE,
  account_id INT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  character_id INT NOT NULL,
  wallet TEXT NOT NULL,
  amount_base NUMERIC(30, 0) NOT NULL,
  copper_credit BIGINT NOT NULL,
  pay_tx_sig TEXT NOT NULL UNIQUE,
  credited_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS realm_power_credits_pending
  ON realm_power_credits(character_id) WHERE credited_at IS NULL;
`;

export async function createQuote(db: Queryable, q: PowerQuoteRow): Promise<void> {
  await db.query(
    `INSERT INTO realm_power_quotes
       (quote_id, realm_id, account_id, character_id, wallet, amount_base, copper_credit,
        sink_wallet, expires_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
    [
      q.quoteId,
      q.realmId,
      q.accountId,
      q.characterId,
      q.wallet,
      q.amountBase.toString(),
      q.copperCredit.toString(),
      q.sinkWallet,
      q.expiresAt,
    ],
  );
}

export async function getQuote(db: Queryable, quoteId: string): Promise<PowerQuoteRow | null> {
  const res = await db.query(
    `SELECT quote_id, realm_id, account_id, character_id, wallet, amount_base, copper_credit,
            sink_wallet, expires_at
       FROM realm_power_quotes WHERE quote_id = $1`,
    [quoteId],
  );
  const r = res.rows[0];
  if (!r) return null;
  return {
    quoteId: String(r.quote_id),
    realmId: Number(r.realm_id),
    accountId: Number(r.account_id),
    characterId: Number(r.character_id),
    wallet: String(r.wallet),
    amountBase: BigInt(String(r.amount_base)),
    copperCredit: BigInt(String(r.copper_credit)),
    sinkWallet: String(r.sink_wallet),
    expiresAt: r.expires_at as Date,
  };
}

export async function deleteQuote(db: Queryable, quoteId: string): Promise<void> {
  await db.query('DELETE FROM realm_power_quotes WHERE quote_id = $1', [quoteId]);
}

export async function insertCredit(
  db: Queryable,
  c: {
    realmId: number;
    accountId: number;
    characterId: number;
    wallet: string;
    amountBase: bigint;
    copperCredit: bigint;
    payTxSig: string;
  },
): Promise<void> {
  await db.query(
    `INSERT INTO realm_power_credits
       (realm_id, account_id, character_id, wallet, amount_base, copper_credit, pay_tx_sig)
     VALUES ($1,$2,$3,$4,$5,$6,$7)`,
    [
      c.realmId,
      c.accountId,
      c.characterId,
      c.wallet,
      c.amountBase.toString(),
      c.copperCredit.toString(),
      c.payTxSig,
    ],
  );
}

// Claim the character's banked credits: marks them credited and returns the
// rows, so the caller can grant the copper (and un-claim on a failed grant).
// The credited_at IS NULL guard makes a concurrent double-claim impossible.
export async function claimPowerCredits(
  db: Queryable,
  characterId: number,
): Promise<{ creditIds: number[]; copper: number }> {
  const res = await db.query(
    `UPDATE realm_power_credits SET credited_at = now()
      WHERE character_id = $1 AND credited_at IS NULL
      RETURNING credit_id, copper_credit`,
    [characterId],
  );
  let copper = 0;
  const creditIds: number[] = [];
  for (const r of res.rows as Array<Record<string, unknown>>) {
    creditIds.push(Number(r.credit_id));
    copper += Number(r.copper_credit);
  }
  return { creditIds, copper };
}

// Un-claim rows whose grant could not apply (the player left between claim and
// grant), so the credit is granted on the next join instead of lost.
export async function unclaimPowerCredits(db: Queryable, creditIds: number[]): Promise<void> {
  if (creditIds.length === 0) return;
  await db.query(
    'UPDATE realm_power_credits SET credited_at = NULL WHERE credit_id = ANY($1::bigint[])',
    [creditIds],
  );
}

export function realmPowerStore(db: Queryable): RealmPowerStore {
  return {
    createQuote: (q) => createQuote(db, q),
    getQuote: (quoteId) => getQuote(db, quoteId),
    deleteQuote: (quoteId) => deleteQuote(db, quoteId),
    insertCredit: (c) => insertCredit(db, c),
  };
}
