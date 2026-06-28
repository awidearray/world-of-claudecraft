// Postgres-backed RentalDb: the $woc ledger behind the GPU-rental marketplace.
//
// $woc is the realm's render-credit currency. Unlike gold/silver/copper (which
// lives in each character's sim inventory state), $woc is a real account
// balance the *server* owns and moves — so renting can never mint or destroy
// credit, only transfer it. Every move is double-entry: one wallet decreases,
// another increases, recorded in an append-only ledger for audit and history.
//
// The schema is appended to the main ensureSchema() run in db.ts.

import type { Pool } from 'pg';
import type { RentalDb } from './rental';
import { SIGNUP_STIPEND } from './rental';

export const RENTAL_SCHEMA = `
CREATE TABLE IF NOT EXISTS woc_wallets (
  character_id INT PRIMARY KEY REFERENCES characters(id) ON DELETE CASCADE,
  balance BIGINT NOT NULL DEFAULT 0 CHECK (balance >= 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS woc_ledger (
  id BIGSERIAL PRIMARY KEY,
  from_character_id INT REFERENCES characters(id) ON DELETE SET NULL,
  to_character_id INT REFERENCES characters(id) ON DELETE SET NULL,
  amount BIGINT NOT NULL CHECK (amount > 0),
  reason TEXT NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS woc_ledger_from ON woc_ledger(from_character_id, created_at DESC);
CREATE INDEX IF NOT EXISTS woc_ledger_to ON woc_ledger(to_character_id, created_at DESC);
`;

export class PgRentalDb implements RentalDb {
  constructor(private readonly pool: Pool) {}

  // Read a balance, opening the wallet with the signup stipend on first touch so
  // every character can buy power from the moment they exist. The INSERT is
  // idempotent (ON CONFLICT) and the stipend is recorded in the ledger as a
  // system grant (from NULL).
  async getBalance(charId: number): Promise<number> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const existing = await client.query('SELECT balance FROM woc_wallets WHERE character_id = $1', [charId]);
      if (existing.rows[0]) {
        await client.query('COMMIT');
        return Number(existing.rows[0].balance);
      }
      await client.query(
        'INSERT INTO woc_wallets (character_id, balance) VALUES ($1, $2) ON CONFLICT (character_id) DO NOTHING',
        [charId, SIGNUP_STIPEND],
      );
      // record the grant only if we actually created the wallet just now
      const created = await client.query('SELECT balance FROM woc_wallets WHERE character_id = $1', [charId]);
      await client.query(
        'INSERT INTO woc_ledger (from_character_id, to_character_id, amount, reason) VALUES (NULL, $1, $2, $3)',
        [charId, SIGNUP_STIPEND, 'stipend:signup'],
      );
      await client.query('COMMIT');
      return Number(created.rows[0]?.balance ?? SIGNUP_STIPEND);
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      throw err;
    } finally {
      client.release();
    }
  }

  // Atomically move `amount` $woc from one wallet to another. Returns false
  // (moving nothing) when the payer can't cover it. Wallets are locked in a
  // stable id order to avoid deadlocks between concurrent transfers.
  async transfer(fromId: number, toId: number, amount: number, reason: string): Promise<boolean> {
    if (!Number.isFinite(amount) || amount <= 0 || fromId === toId) return false;
    const amt = Math.floor(amount);
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      // make sure both wallets exist (stipend-funded on creation)
      await this.ensureWallet(client, fromId);
      await this.ensureWallet(client, toId);
      // lock both rows in ascending id order
      const [lo, hi] = fromId < toId ? [fromId, toId] : [toId, fromId];
      await client.query('SELECT balance FROM woc_wallets WHERE character_id IN ($1, $2) ORDER BY character_id FOR UPDATE', [lo, hi]);
      const payer = await client.query('SELECT balance FROM woc_wallets WHERE character_id = $1', [fromId]);
      const balance = Number(payer.rows[0]?.balance ?? 0);
      if (balance < amt) {
        await client.query('ROLLBACK');
        return false;
      }
      await client.query('UPDATE woc_wallets SET balance = balance - $2, updated_at = now() WHERE character_id = $1', [fromId, amt]);
      await client.query('UPDATE woc_wallets SET balance = balance + $2, updated_at = now() WHERE character_id = $1', [toId, amt]);
      await client.query(
        'INSERT INTO woc_ledger (from_character_id, to_character_id, amount, reason) VALUES ($1, $2, $3, $4)',
        [fromId, toId, amt, String(reason ?? '').slice(0, 200)],
      );
      await client.query('COMMIT');
      return true;
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      throw err;
    } finally {
      client.release();
    }
  }

  private async ensureWallet(client: { query: Pool['query'] }, charId: number): Promise<void> {
    const res = await client.query(
      'INSERT INTO woc_wallets (character_id, balance) VALUES ($1, $2) ON CONFLICT (character_id) DO NOTHING RETURNING character_id',
      [charId, SIGNUP_STIPEND],
    );
    // only ledger the stipend when this INSERT actually created the wallet
    if ((res.rowCount ?? 0) > 0) {
      await client.query(
        'INSERT INTO woc_ledger (from_character_id, to_character_id, amount, reason) VALUES (NULL, $1, $2, $3)',
        [charId, SIGNUP_STIPEND, 'stipend:signup'],
      );
    }
  }
}
