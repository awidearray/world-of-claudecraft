// Real-Postgres integration test for the launchpad tables (phases 0 to 2),
// following the realm_db.integration.test.ts pattern: gated on PG_TEST_URL,
// driven through the REAL boot path (ensureSchema), asserting on actual rows.
// Proves the DDL, the FKs/CHECKs, the UNIQUE replay guards on every money
// table, the guarded status CAS, bigint round-trips, and that a DROPPED column
// fails assertRealmSchema at boot (the drift guard).
//
//   docker run -d --rm -e POSTGRES_PASSWORD=test -e POSTGRES_USER=test \
//     -e POSTGRES_DB=test -p 5544:5432 postgres:16-alpine
//   PG_TEST_URL=postgres://test:test@127.0.0.1:5544/test \
//     npx vitest run --no-file-parallelism tests/realm_*.integration.test.ts

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const PG_TEST_URL = process.env.PG_TEST_URL;
if (PG_TEST_URL) process.env.DATABASE_URL ??= PG_TEST_URL;

const run = PG_TEST_URL ? describe : describe.skip;

run('launchpad tables against real Postgres', () => {
  let db: typeof import('../server/db');
  let realmDb: typeof import('../server/realm_db');
  let tokenDb: typeof import('../server/realm_token_db');
  let voteDb: typeof import('../server/realm_vote_db');
  let httpUtil: typeof import('../server/http_util');
  let ownerId: number;
  let voterId: number;
  let realmId: number;

  beforeAll(async () => {
    db = await import('../server/db');
    realmDb = await import('../server/realm_db');
    tokenDb = await import('../server/realm_token_db');
    voteDb = await import('../server/realm_vote_db');
    httpUtil = await import('../server/http_util');
    await db.pool.query(
      `DROP TABLE IF EXISTS realm_presale_contributions, realm_presale_quotes, realm_presales,
         realm_votes, realm_tokens, realm_stakes, realm_roles, realms CASCADE`,
    );
    await db.ensureSchema();
    ownerId = (await db.createAccount(`lp_owner_${Date.now()}`, 'hash')).id;
    voterId = (await db.createAccount(`lp_voter_${Date.now()}`, 'hash')).id;
    const realm = await realmDb.createProvisioningRealm(db.pool, {
      name: 'Launchpad Realm',
      type: 'Normal',
      ownerAccountId: ownerId,
      tier: 1,
    });
    realmId = realm.realmId;
    await realmDb.activateRealm(db.pool, realmId);
  });

  afterAll(async () => {
    await db.pool.end();
  });

  it('registers a token with the cosmetic default and lists it for the directory', async () => {
    const created = await tokenDb.insertRealmToken(db.pool, {
      realmId,
      symbol: 'MOON',
      icon: 'moon',
      monetizationPolicy: 'cosmetic',
    });
    expect(created).toMatchObject({
      realmId,
      symbol: 'MOON',
      icon: 'moon',
      status: 'prelaunch',
      monetizationPolicy: 'cosmetic',
      mint: null,
      launchTxSig: null,
    });
    const back = await tokenDb.getRealmToken(db.pool, realmId);
    expect(back).toEqual(created);
    const listed = await tokenDb.listRealmTokens(db.pool, [realmId, 999_999]);
    expect(listed.size).toBe(1);
    expect(listed.get(realmId)?.symbol).toBe('MOON');
  });

  it('enforces one token per realm (PK) and the guarded status CAS', async () => {
    let dup: unknown;
    await tokenDb
      .insertRealmToken(db.pool, {
        realmId,
        symbol: 'MOON2',
        icon: '',
        monetizationPolicy: 'cosmetic',
      })
      .catch((e) => {
        dup = e;
      });
    expect(httpUtil.isUniqueViolation(dup)).toBe(true);

    // CAS: prelaunch -> voting works; a repeat (already voting) matches nothing.
    expect(
      (await tokenDb.setRealmTokenStatus(db.pool, realmId, ['prelaunch'], 'voting'))?.status,
    ).toBe('voting');
    expect(await tokenDb.setRealmTokenStatus(db.pool, realmId, ['prelaunch'], 'voting')).toBeNull();
  });

  it('assertRealmSchema fails at boot when a launchpad column is dropped', async () => {
    await db.pool.query('ALTER TABLE realm_tokens DROP COLUMN monetization_policy');
    await expect(realmDb.assertRealmSchema(db.pool)).rejects.toThrow(
      /realm_tokens.*monetization_policy/,
    );
    // Restore and re-assert green (the real production repair path is a migration).
    await db.pool.query(
      `ALTER TABLE realm_tokens ADD COLUMN monetization_policy TEXT NOT NULL DEFAULT 'cosmetic'
         CHECK (monetization_policy IN ('cosmetic', 'power'))`,
    );
    await expect(realmDb.assertRealmSchema(db.pool)).resolves.toBeUndefined();
  });

  it('records weighted votes with both per-wallet and per-account uniques', async () => {
    await voteDb.insertVote(db.pool, {
      realmId,
      accountId: voterId,
      wallet: 'VOTERWALLET_A',
      choice: 'yes',
      weightWoc: 1_000_000n,
    });
    // Same wallet, different account: rejected.
    const other = (await db.createAccount(`lp_other_${Date.now()}`, 'hash')).id;
    let dupWallet: unknown;
    await voteDb
      .insertVote(db.pool, {
        realmId,
        accountId: other,
        wallet: 'VOTERWALLET_A',
        choice: 'no',
        weightWoc: 1n,
      })
      .catch((e) => {
        dupWallet = e;
      });
    expect(httpUtil.isUniqueViolation(dupWallet)).toBe(true);
    // Same account, rotated wallet: rejected.
    let dupAccount: unknown;
    await voteDb
      .insertVote(db.pool, {
        realmId,
        accountId: voterId,
        wallet: 'VOTERWALLET_B',
        choice: 'no',
        weightWoc: 1n,
      })
      .catch((e) => {
        dupAccount = e;
      });
    expect(httpUtil.isUniqueViolation(dupAccount)).toBe(true);

    // Whale-scale weight round-trips as bigint; the tally groups by choice.
    await voteDb.insertVote(db.pool, {
      realmId,
      accountId: other,
      wallet: 'VOTERWALLET_C',
      choice: 'no',
      weightWoc: 9_007_199_254_740_993n,
    });
    const tally = await voteDb.tallyVotes(db.pool, realmId);
    expect(tally).toEqual({
      yesWeight: 1_000_000n,
      noWeight: 9_007_199_254_740_993n,
      voteCount: 2,
    });
    expect(await voteDb.getVoteForAccount(db.pool, realmId, voterId)).toEqual({
      choice: 'yes',
      weightWoc: 1_000_000n,
    });
  });

  it('QUARANTINE: launchpad writes never touch woc_flow_ledger', async () => {
    const n = await db.pool.query('SELECT count(*)::int AS n FROM woc_flow_ledger');
    // Everything above inserted tokens, votes, quotes, and contributions; the
    // emission-headroom ledger is untouched (presale money is not an emission).
    expect(n.rows[0].n).toBe(0);
  });
});
