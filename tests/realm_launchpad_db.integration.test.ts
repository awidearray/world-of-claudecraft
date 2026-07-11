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
      `DROP TABLE IF EXISTS levy_fund_holdings, levy_fund_snapshots, levy_fund_marks,
         realm_fee_distributions, realm_fee_accruals, realm_launch_quotes,
         realm_presale_contributions, realm_presale_quotes, realm_presales,
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

  it('phase 3 launch writes: guarded CAS columns + UNIQUE launch sigs + NUMERIC round-trip', async () => {
    // recordMintCreated is guarded on status 'funded' and mint IS NULL.
    expect(
      await tokenDb.recordMintCreated(db.pool, realmId, 'MintPub111', 'launchsig_1'),
    ).toBeNull();
    await tokenDb.setRealmTokenStatus(db.pool, realmId, ['voting'], 'funded');
    const minted = await tokenDb.recordMintCreated(db.pool, realmId, 'MintPub111', 'launchsig_1');
    expect(minted?.mint).toBe('MintPub111');
    expect(minted?.launchTxSig).toBe('launchsig_1');
    // Once written, the guard never matches again.
    expect(
      await tokenDb.recordMintCreated(db.pool, realmId, 'MintPub222', 'launchsig_2'),
    ).toBeNull();

    // recordDistribution: NUMERIC(30,0) round-trips past 2^63 as exact bigint.
    const big = 9_223_372_036_854_775_808n * 100n;
    const distributed = await tokenDb.recordDistribution(db.pool, realmId, {
      distributeTxSig: 'distsig_1',
      supplyBase: big,
      founderAllocBase: (big * 12n) / 100n,
      levyAllocBase: (big * 8n) / 100n,
      treasuryAllocBase: (big * 10n) / 100n,
    });
    expect(distributed?.supplyBase).toBe(big);
    expect(distributed?.founderAllocBase).toBe((big * 12n) / 100n);
    expect(
      await tokenDb.recordDistribution(db.pool, realmId, {
        distributeTxSig: 'distsig_2',
        supplyBase: 1n,
        founderAllocBase: 1n,
        levyAllocBase: 1n,
        treasuryAllocBase: 1n,
      }),
    ).toBeNull();

    // Each lock address records exactly once.
    const locked = await tokenDb.recordLockAddress(db.pool, realmId, 'levy', 'EscrowLevy1');
    expect(locked?.levyLockAddress).toBe('EscrowLevy1');
    expect(await tokenDb.recordLockAddress(db.pool, realmId, 'levy', 'EscrowLevy2')).toBeNull();

    // launch_tx_sig / distribute_tx_sig are UNIQUE across realms.
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
    await tokenDb.setRealmTokenStatus(db.pool, realm2.realmId, ['prelaunch'], 'funded');
    let dupSig: unknown;
    await tokenDb
      .recordMintCreated(db.pool, realm2.realmId, 'MintPub333', 'launchsig_1')
      .catch((e) => {
        dupSig = e;
      });
    expect(httpUtil.isUniqueViolation(dupSig)).toBe(true);
  });

  it('phase 3 launch quotes: JSONB payload round-trip + expiry pruning', async () => {
    const mintDb = await import('../server/realm_token_mint_db');
    const store = mintDb.launchQuoteStore(db.pool);
    await store.createQuote({
      quoteId: 'lq-int-1',
      realmId,
      accountId: voterId,
      kind: 'lock',
      payload: { bucket: 'levy', escrow: 'EscrowLevy1', amountBase: '123456789012345678901' },
      expiresAt: new Date(Date.now() + 60_000),
    });
    const back = await store.getQuote('lq-int-1');
    expect(back?.kind).toBe('lock');
    expect(back?.payload).toEqual({
      bucket: 'levy',
      escrow: 'EscrowLevy1',
      amountBase: '123456789012345678901',
    });
    // An expired row is pruned by the next create.
    await db.pool.query(
      `UPDATE realm_launch_quotes SET expires_at = now() - interval '1 minute'
        WHERE quote_id = 'lq-int-1'`,
    );
    await store.createQuote({
      quoteId: 'lq-int-2',
      realmId,
      accountId: voterId,
      kind: 'mint',
      payload: { mint: 'MintPub111' },
      expiresAt: new Date(Date.now() + 60_000),
    });
    expect(await store.getQuote('lq-int-1')).toBeNull();
    await store.deleteQuote('lq-int-2');
    expect(await store.getQuote('lq-int-2')).toBeNull();
  });

  it('phase 4 curve writes: one-shot launch record, LP lock once, widened quote kinds', async () => {
    // A third realm launches on the curve path.
    const realm3 = await realmDb.createProvisioningRealm(db.pool, {
      name: 'Launchpad Realm Curve',
      type: 'Normal',
      ownerAccountId: ownerId,
      tier: 1,
    });
    await realmDb.activateRealm(db.pool, realm3.realmId);
    await tokenDb.insertRealmToken(db.pool, {
      realmId: realm3.realmId,
      symbol: 'CURVY',
      icon: '',
      monetizationPolicy: 'cosmetic',
    });
    // Guarded on status 'funded'.
    const launch = {
      mint: 'CurveMint111',
      launchTxSig: 'curvesig_1',
      curveAddress: 'CurveCfg111',
      poolAddress: 'CurvePool111',
      feeClaimerPda: 'FeeVault111',
      supplyBase: 10n ** 18n,
      founderAllocBase: 12n * 10n ** 16n,
      levyAllocBase: 8n * 10n ** 16n,
      treasuryAllocBase: 10n ** 17n,
    };
    expect(await tokenDb.recordCurveLaunch(db.pool, realm3.realmId, launch)).toBeNull();
    await tokenDb.setRealmTokenStatus(db.pool, realm3.realmId, ['prelaunch'], 'funded');
    const launched = await tokenDb.recordCurveLaunch(db.pool, realm3.realmId, launch);
    expect(launched?.mint).toBe('CurveMint111');
    expect(launched?.curveAddress).toBe('CurveCfg111');
    expect(launched?.poolAddress).toBe('CurvePool111');
    expect(launched?.supplyBase).toBe(10n ** 18n);
    // One-shot: the guard never matches again.
    expect(
      await tokenDb.recordCurveLaunch(db.pool, realm3.realmId, {
        ...launch,
        launchTxSig: 'curvesig_2',
      }),
    ).toBeNull();

    // The curve path unlocks recordLockAddress before any distribution row.
    const locked = await tokenDb.recordLockAddress(db.pool, realm3.realmId, 'founder', 'Locker1');
    expect(locked?.founderLockAddress).toBe('Locker1');

    // The LP lock records once and only for a pool-bearing token.
    const lp = await tokenDb.recordLpLock(db.pool, realm3.realmId, 'DammPool111');
    expect(lp?.lpLockAddress).toBe('DammPool111');
    expect(await tokenDb.recordLpLock(db.pool, realm3.realmId, 'DammPool222')).toBeNull();
    expect(await tokenDb.recordLpLock(db.pool, realmId, 'DammPool333')).toBeNull(); // no pool

    // The widened kind vocabulary round-trips ('curve' + 'leftover').
    const mintDb = await import('../server/realm_token_mint_db');
    const store = mintDb.launchQuoteStore(db.pool);
    for (const kind of ['curve', 'leftover'] as const) {
      await store.createQuote({
        quoteId: `kq-${kind}`,
        realmId: realm3.realmId,
        accountId: voterId,
        kind,
        payload: { poolAddress: 'CurvePool111' },
        expiresAt: new Date(Date.now() + 60_000),
      });
      expect((await store.getQuote(`kq-${kind}`))?.kind).toBe(kind);
      await store.deleteQuote(`kq-${kind}`);
    }
  });

  it('phase 5 fee tables: accrual replay guard, per-realm balance, leg UNIQUE, advisory lock', async () => {
    const feeDb = await import('../server/realm_fee_db');
    // Two curve realms accrue independently.
    const realmA = realmId;
    const realmB = (
      await realmDb.createProvisioningRealm(db.pool, {
        name: 'Fee Realm B',
        type: 'Normal',
        ownerAccountId: ownerId,
        tier: 1,
      })
    ).realmId;
    await realmDb.activateRealm(db.pool, realmB);

    // Accrual UNIQUE(claim_tx_sig): the same claim can never accrue twice.
    expect(
      await feeDb.insertFeeAccrual(db.pool, {
        realmId: realmA,
        currency: 'USDC',
        amountBase: 5_000_000n,
        claimTxSig: 'feeclaim_a1',
      }),
    ).toBe(true);
    expect(
      await feeDb.insertFeeAccrual(db.pool, {
        realmId: realmA,
        currency: 'USDC',
        amountBase: 5_000_000n,
        claimTxSig: 'feeclaim_a1',
      }),
    ).toBe(false);
    await feeDb.insertFeeAccrual(db.pool, {
      realmId: realmB,
      currency: 'USDC',
      amountBase: 3_000_000n,
      claimTxSig: 'feeclaim_b1',
    });
    // Per-realm attribution off the shared vault is exact.
    expect(await feeDb.unspentAccruedBase(db.pool, realmA, 'USDC')).toBe(5_000_000n);
    expect(await feeDb.unspentAccruedBase(db.pool, realmB, 'USDC')).toBe(3_000_000n);
    expect(await feeDb.unspentAccruedBase(db.pool, realmA, 'SOL')).toBe(0n);

    // A distribution reduces the realm's unspent balance in full.
    const distId = await feeDb.createFeeDistribution(db.pool, {
      realmId: realmA,
      currency: 'USDC',
      totalBase: 5_000_000n,
      operatorBase: 2_125_000n,
      treasuryBase: 1_000_000n,
      affiliateBase: 375_000n,
      burnBase: 1_500_000n,
      operatorWallet: 'OpWallet',
      treasuryWallet: 'TreasuryWallet',
      affiliateWallet: 'AffWallet',
      burnDest: 'BurnDest',
    });
    expect(await feeDb.unspentAccruedBase(db.pool, realmA, 'USDC')).toBe(0n);

    // Leg signatures record before broadcast; UNIQUE per column across rows.
    await feeDb.recordFeeLegSig(db.pool, distId, 'operator', 'opsig_1');
    await feeDb.markFeeLegPaid(db.pool, distId, 'operator');
    const dist2 = await feeDb.createFeeDistribution(db.pool, {
      realmId: realmB,
      currency: 'USDC',
      totalBase: 3_000_000n,
      operatorBase: 1_275_000n,
      treasuryBase: 600_000n,
      affiliateBase: 225_000n,
      burnBase: 900_000n,
      operatorWallet: 'OpWalletB',
      treasuryWallet: 'TreasuryWallet',
      affiliateWallet: null,
      burnDest: 'BurnDest',
    });
    let sigReuse: unknown;
    await feeDb.recordFeeLegSig(db.pool, dist2, 'operator', 'opsig_1').catch((e) => {
      sigReuse = e;
    });
    expect(httpUtil.isUniqueViolation(sigReuse)).toBe(true);

    // The open distribution is the paying one; marking it paid closes it.
    const open = await feeDb.openFeeDistribution(db.pool, realmA, 'USDC');
    expect(open?.distributionId).toBe(distId);
    expect(open?.legPaid.operator).toBe(true);
    await feeDb.markFeeDistributionPaid(db.pool, distId);
    expect(await feeDb.openFeeDistribution(db.pool, realmA, 'USDC')).toBeNull();

    // The advisory TRY-lock: a second holder cannot enter while the first owns
    // the realm.
    let innerRan = false;
    const outer = await feeDb.withRealmFeeLock(db.pool, realmA, async () => {
      const inner = await feeDb.withRealmFeeLock(db.pool, realmA, async () => {
        innerRan = true;
        return 'inner';
      });
      expect(inner).toBeNull(); // contended: skipped, not blocked
      return 'outer';
    });
    expect(outer).toBe('outer');
    expect(innerRan).toBe(false);

    // listFeeRealms surfaces only curve-launched realms (a pool exists).
    await tokenDb.insertRealmToken(db.pool, {
      realmId: realmB,
      symbol: 'FEEB',
      icon: '',
      monetizationPolicy: 'cosmetic',
    });
    await tokenDb.setRealmTokenStatus(db.pool, realmB, ['prelaunch'], 'funded');
    const withPool = await tokenDb.recordCurveLaunch(db.pool, realmB, {
      mint: 'FeeCurveMint',
      launchTxSig: 'feecurvesig',
      curveAddress: 'FeeCurveCfg',
      poolAddress: 'FeeCurvePool',
      feeClaimerPda: 'FeeVault',
      supplyBase: 10n ** 18n,
      founderAllocBase: 12n * 10n ** 16n,
      levyAllocBase: 8n * 10n ** 16n,
      treasuryAllocBase: 10n ** 17n,
    });
    expect(withPool).not.toBeNull();
    const feeRealms = await feeDb.listFeeRealms(db.pool);
    expect(feeRealms.some((r) => r.realmId === realmB && r.poolAddress === 'FeeCurvePool')).toBe(
      true,
    );
  });

  it('phase 6 levy fund: snapshot round-trip, latest read, rolling marks, holding sources', async () => {
    const levyDb = await import('../server/levy_fund_db');
    // A launched realm token with a levy allocation is a fund holding source.
    const lr = (
      await realmDb.createProvisioningRealm(db.pool, {
        name: 'Levy Realm',
        type: 'Normal',
        ownerAccountId: ownerId,
        tier: 1,
      })
    ).realmId;
    await realmDb.activateRealm(db.pool, lr);
    await tokenDb.insertRealmToken(db.pool, {
      realmId: lr,
      symbol: 'LEVY',
      icon: '',
      monetizationPolicy: 'cosmetic',
    });
    await tokenDb.setRealmTokenStatus(db.pool, lr, ['prelaunch'], 'funded');
    await tokenDb.recordCurveLaunch(db.pool, lr, {
      mint: 'LevyMint',
      launchTxSig: 'levysig',
      curveAddress: 'LevyCfg',
      poolAddress: 'LevyPool',
      feeClaimerPda: 'FeeVault',
      supplyBase: 10n ** 18n,
      founderAllocBase: 12n * 10n ** 16n,
      levyAllocBase: 8n * 10n ** 16n,
      treasuryAllocBase: 10n ** 17n,
    });
    // Not a source until it lists (status live/graduated).
    expect(await levyDb.levyHoldingSources(db.pool)).toEqual([]);
    await tokenDb.setRealmTokenStatus(db.pool, lr, ['funded'], 'live');
    const srcs = await levyDb.levyHoldingSources(db.pool);
    expect(srcs).toHaveLength(1);
    expect(srcs[0]).toMatchObject({
      mint: 'LevyMint',
      levyAllocBase: 8n * 10n ** 16n,
      status: 'live',
    });

    // Rolling marks accumulate and read oldest-first, bounded per mint.
    await levyDb.insertMark(db.pool, 'LevyMint', 0.01);
    await levyDb.insertMark(db.pool, 'LevyMint', 0.012);
    await levyDb.insertMark(db.pool, 'LevyMint', 0.011);
    expect(await levyDb.recentMarks(db.pool, 'LevyMint', 2)).toEqual([0.012, 0.011]);

    // A snapshot round-trips (totals + holdings), and latestSnapshot reads it.
    const snapId = await levyDb.insertSnapshot(db.pool, {
      aumUsd: 800_000,
      aumSol: 5_333,
      holdingCount: 1,
      includedCount: 1,
      clamped: false,
      solUsd: 150,
      holdings: [
        {
          realmId: lr,
          mint: 'LevyMint',
          symbol: 'LEVY',
          amountBase: 8n * 10n ** 16n,
          decimals: 9,
          priceUsd: 0.01,
          valueUsd: 800_000,
          valueSol: 5_333,
          weightBps: 10_000,
          source: 'jupiter_v3',
          illiquid: false,
          note: null,
          lockAddress: 'LevyLock',
        },
      ],
    });
    expect(snapId).toBeGreaterThan(0);
    expect(await levyDb.previousAum(db.pool)).toBe(800_000);
    const latest = await levyDb.latestSnapshot(db.pool);
    expect(latest?.aumUsd).toBe(800_000);
    expect(latest?.holdings).toHaveLength(1);
    expect(latest?.holdings[0]).toMatchObject({
      mint: 'LevyMint',
      amountBase: 8n * 10n ** 16n,
      valueUsd: 800_000,
      illiquid: false,
    });
  });

  it('assertRealmSchema fails at boot when a phase-3 launch column is dropped', async () => {
    await db.pool.query('ALTER TABLE realm_tokens DROP COLUMN distribute_tx_sig');
    await expect(realmDb.assertRealmSchema(db.pool)).rejects.toThrow(
      /realm_tokens.*distribute_tx_sig/,
    );
    await db.pool.query('ALTER TABLE realm_tokens ADD COLUMN distribute_tx_sig TEXT UNIQUE');
    await expect(realmDb.assertRealmSchema(db.pool)).resolves.toBeUndefined();
  });

  it('QUARANTINE: launchpad writes never touch woc_flow_ledger', async () => {
    const n = await db.pool.query('SELECT count(*)::int AS n FROM woc_flow_ledger');
    // Everything above inserted tokens, votes, quotes, and contributions; the
    // emission-headroom ledger is untouched (presale money is not an emission).
    expect(n.rows[0].n).toBe(0);
  });
});
