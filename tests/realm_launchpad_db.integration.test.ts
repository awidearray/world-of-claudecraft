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
  let presaleDb: typeof import('../server/realm_presale_db');
  let httpUtil: typeof import('../server/http_util');
  let ownerId: number;
  let voterId: number;
  let realmId: number;

  beforeAll(async () => {
    db = await import('../server/db');
    realmDb = await import('../server/realm_db');
    tokenDb = await import('../server/realm_token_db');
    voteDb = await import('../server/realm_vote_db');
    presaleDb = await import('../server/realm_presale_db');
    httpUtil = await import('../server/http_util');
    await db.pool.query(
      `DROP TABLE IF EXISTS realm_presale_contributions, realm_presale_quotes, realm_presales,
         realm_votes, realm_token_launches, realm_tokens, realm_stakes, realm_roles, realms CASCADE`,
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

  it('persists the presale config rails and round-trips quotes', async () => {
    const store = presaleDb.realmPresaleStore(db.pool);
    await store.createPresale({
      realmId,
      escrowWallet: 'So11111111111111111111111111111111111111112',
      rails: {
        SOL: {
          softCapBase: 1_000_000_000n,
          raiseCapBase: 2_000_000_000n,
          walletCapBase: 500_000_000n,
        },
        USDC: { softCapBase: 5_000_000n, raiseCapBase: 10_000_000n, walletCapBase: 1_000_000n },
      },
    });
    const config = await store.getPresale(realmId);
    expect(config?.escrowWallet).toBe('So11111111111111111111111111111111111111112');
    expect(config?.rails.SOL?.raiseCapBase).toBe(2_000_000_000n);
    expect(config?.rails.WOC).toBeUndefined(); // disabled rail stays off

    const expiresAt = new Date(Date.now() + 60_000);
    await store.createQuote({
      quoteId: 'q-int-1',
      realmId,
      accountId: voterId,
      wallet: 'CONTRIBWALLET',
      currency: 'SOL',
      amountBase: 123_456_789n,
      escrowAddr: config!.escrowWallet,
      expiresAt,
    });
    const quote = await store.getQuote('q-int-1');
    expect(quote).toMatchObject({
      currency: 'SOL',
      amountBase: 123_456_789n,
      wallet: 'CONTRIBWALLET',
    });
    await store.deleteQuote('q-int-1');
    expect(await store.getQuote('q-int-1')).toBeNull();
  });

  it('contribution ledger: UNIQUE(pay_tx_sig) replay guard + per-rail sums', async () => {
    const store = presaleDb.realmPresaleStore(db.pool);
    await store.insertContribution({
      realmId,
      accountId: voterId,
      wallet: 'CONTRIBWALLET',
      currency: 'SOL',
      amountBase: 100_000_000n,
      payTxSig: 'paysig_int_1',
    });
    let dup: unknown;
    await store
      .insertContribution({
        realmId,
        accountId: voterId,
        wallet: 'CONTRIBWALLET',
        currency: 'SOL',
        amountBase: 100_000_000n,
        payTxSig: 'paysig_int_1',
      })
      .catch((e) => {
        dup = e;
      });
    expect(httpUtil.isUniqueViolation(dup)).toBe(true);

    await store.insertContribution({
      realmId,
      accountId: voterId,
      wallet: 'CONTRIBWALLET',
      currency: 'USDC',
      amountBase: 250_000n,
      payTxSig: 'paysig_int_2',
    });
    const raised = await store.raisedByCurrency(realmId);
    expect(raised.get('SOL')).toBe(100_000_000n);
    expect(raised.get('USDC')).toBe(250_000n);
    expect(await store.contributedByWallet(realmId, 'CONTRIBWALLET', 'SOL')).toBe(100_000_000n);
    expect(await store.contributedByWallet(realmId, 'NOBODY', 'SOL')).toBe(0n);
  });

  it('refund marking: unrefunded-only, UNIQUE(refund_tx_sig), and the counter', async () => {
    const store = presaleDb.realmPresaleStore(db.pool);
    expect(await store.countUnrefunded(realmId)).toBe(2);
    const c = await store.getContributionByPaySig('paysig_int_1');
    expect(c).not.toBeNull();
    expect(await store.markRefunded(c!.contributionId, 'refundsig_int_1')).toBe(true);
    // Idempotence: a second mark on the same row matches nothing.
    expect(await store.markRefunded(c!.contributionId, 'refundsig_int_other')).toBe(false);
    // One refund tx cannot cover a second contribution.
    const c2 = await store.getContributionByPaySig('paysig_int_2');
    let reuse: unknown;
    await store.markRefunded(c2!.contributionId, 'refundsig_int_1').catch((e) => {
      reuse = e;
    });
    expect(httpUtil.isUniqueViolation(reuse)).toBe(true);
    expect(await store.countUnrefunded(realmId)).toBe(1);
  });

  it('withPresaleLock serializes: the callback commits atomically', async () => {
    const store = presaleDb.realmPresaleStore(db.pool);
    // A throwing callback rolls its insert back.
    await store
      .withPresaleLock(realmId, async (locked) => {
        await locked.insertContribution({
          realmId,
          accountId: voterId,
          wallet: 'CONTRIBWALLET',
          currency: 'SOL',
          amountBase: 1n,
          payTxSig: 'paysig_rollback',
        });
        throw new Error('boom');
      })
      .catch(() => {});
    expect(await store.getContributionByPaySig('paysig_rollback')).toBeNull();
    // A clean callback commits.
    await store.withPresaleLock(realmId, async (locked) => {
      await locked.insertContribution({
        realmId,
        accountId: voterId,
        wallet: 'CONTRIBWALLET',
        currency: 'SOL',
        amountBase: 1n,
        payTxSig: 'paysig_commit',
      });
    });
    expect(await store.getContributionByPaySig('paysig_commit')).not.toBeNull();
  });

  it('launch pipeline (phase 3): pinned snapshot, atomic confirm, replay guard', async () => {
    const store = tokenDb.realmTokenLaunchStore(db.pool);
    const alloc = {
      publicBps: 6000,
      liquidityBps: 1000,
      founderBps: 1200,
      levyBps: 800,
      treasuryBps: 1000,
    };
    // NUMERIC(30,0) supply round-trips past BIGINT headroom (10^19).
    const supplyBase = 10_000_000_000n * 10n ** 9n;
    const pin = {
      realmId,
      pendingMint: 'MintPin111',
      supplyBase,
      alloc,
      founderWallet: 'FOUNDERW',
      levyWallet: 'LEVYW',
      treasuryWallet: 'TREASW',
    };
    expect(await store.upsertPendingLaunch(pin)).toBe(true);
    // Lock addresses are rejected before the mint confirm.
    expect(
      await store.setLockAddresses(realmId, { founder: 'FL', levy: 'LL', treasury: 'TL' }),
    ).toBe(false);
    // Re-prepare replaces the pending mint while unconfirmed.
    expect(await store.upsertPendingLaunch({ ...pin, pendingMint: 'MintPin222' })).toBe(true);
    const launch = await store.getLaunch(realmId);
    expect(launch).toMatchObject({ pendingMint: 'MintPin222', supplyBase, alloc });
    expect(launch?.mintConfirmedAt).toBeNull();

    // Atomic confirm: realm_tokens.mint + launch_tx_sig + the launch stamp.
    expect(await store.recordMintCreated(realmId, 'MintPin222', 'launchsig_int_1')).toBe(true);
    const token = await tokenDb.getRealmToken(db.pool, realmId);
    expect(token?.mint).toBe('MintPin222');
    expect(token?.launchTxSig).toBe('launchsig_int_1');
    expect((await store.getLaunch(realmId))?.mintConfirmedAt).not.toBeNull();
    // A second confirm (mint already set) matches nothing.
    expect(await store.recordMintCreated(realmId, 'MintPin222', 'launchsig_int_2')).toBe(false);
    // A confirmed launch is immutable: re-prepare matches nothing.
    expect(await store.upsertPendingLaunch({ ...pin, pendingMint: 'MintPin333' })).toBe(false);

    // The launch signature replay guard is the realm_tokens UNIQUE: a second
    // realm reusing the same signature violates it, and its own launch row
    // stays unconfirmed (the transaction rolled back).
    const realm2 = await realmDb.createProvisioningRealm(db.pool, {
      name: 'Launchpad Realm Two',
      type: 'Normal',
      ownerAccountId: ownerId,
      tier: 1,
    });
    await realmDb.activateRealm(db.pool, realm2.realmId);
    await tokenDb.insertRealmToken(db.pool, {
      realmId: realm2.realmId,
      symbol: 'MOONB',
      icon: '',
      monetizationPolicy: 'cosmetic',
    });
    expect(
      await store.upsertPendingLaunch({
        ...pin,
        realmId: realm2.realmId,
        pendingMint: 'MintPin444',
      }),
    ).toBe(true);
    let replay: unknown;
    await store.recordMintCreated(realm2.realmId, 'MintPin444', 'launchsig_int_1').catch((e) => {
      replay = e;
    });
    expect(httpUtil.isUniqueViolation(replay)).toBe(true);
    expect((await store.getLaunch(realm2.realmId))?.mintConfirmedAt).toBeNull();
    expect((await tokenDb.getRealmToken(db.pool, realm2.realmId))?.mint).toBeNull();

    // Lock pinning + the verified stamp, each guarded to fire exactly once.
    expect(
      await store.setLockAddresses(realmId, { founder: 'FL', levy: 'LL', treasury: 'TL' }),
    ).toBe(true);
    expect(await store.markLocksVerified(realmId)).toBe(true);
    expect(await store.markLocksVerified(realmId)).toBe(false);
    // Verified locks are pinned: address updates match nothing afterward.
    expect(
      await store.setLockAddresses(realmId, { founder: 'X', levy: 'Y', treasury: 'Z' }),
    ).toBe(false);
    const done = await store.getLaunch(realmId);
    expect(done?.founderLockAddress).toBe('FL');
    expect(done?.locksVerifiedAt).not.toBeNull();
  });

  it('assertRealmSchema fails at boot when a launch-pipeline column is dropped', async () => {
    await db.pool.query('ALTER TABLE realm_token_launches DROP COLUMN locks_verified_at');
    await expect(realmDb.assertRealmSchema(db.pool)).rejects.toThrow(
      /realm_token_launches.*locks_verified_at/,
    );
    await db.pool.query('ALTER TABLE realm_token_launches ADD COLUMN locks_verified_at TIMESTAMPTZ');
    await expect(realmDb.assertRealmSchema(db.pool)).resolves.toBeUndefined();
  });

  it('QUARANTINE: launchpad writes never touch woc_flow_ledger', async () => {
    const n = await db.pool.query('SELECT count(*)::int AS n FROM woc_flow_ledger');
    // Everything above inserted tokens, votes, quotes, and contributions; the
    // emission-headroom ledger is untouched (presale money is not an emission).
    expect(n.rows[0].n).toBe(0);
  });
});
