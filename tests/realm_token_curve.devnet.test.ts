// Live-devnet integration for launchpad phase 4: the REAL Meteora DBC venue
// end to end against the devnet deployments of the Dynamic Bonding Curve,
// DAMM v2, and Jupiter Lock programs. Drives the production orchestration
// (prepareCurveQuote / confirmCurveLaunch / curveState / reconcileCurve /
// prepareLeftoverQuote / confirmLeftover) plus the phase-3 lock flow for the
// levy + treasury buckets, with a tiny 1-SOL migration threshold so the curve
// actually graduates inside the test:
//
//   launch config+pool -> buy through the curve to the threshold ->
//   createLocker (founder vesting) -> migrateToDammV2 (permanent LP) ->
//   reconcile (founder lock + LP lock recorded) -> withdraw leftover ->
//   jup-lock levy + treasury -> reconcile -> live -> graduated
//
// The acceptance MAINNET dry-run remains gated on the owner's sign-off; this
// suite proves everything provable without a mainnet transaction.
//
// Gated on WOC_DEVNET_TEST=1:
//   WOC_DEVNET_TEST=1 npx vitest run tests/realm_token_curve.devnet.test.ts

import { readFileSync } from 'node:fs';
import { Connection, Keypair, PublicKey, Transaction } from '@solana/web3.js';
import bs58 from 'bs58';
import { describe, expect, it } from 'vitest';
import type { RealmToken, RealmTokenDb } from '../server/realm_token';
import type { CurveDeps } from '../server/realm_token_curve';
import type { LaunchQuoteRow, LaunchQuoteStore } from '../server/realm_token_mint';

const RUN = process.env.WOC_DEVNET_TEST === '1';
const DEVNET_RPC = 'https://api.devnet.solana.com';
process.env.SOLANA_RPC_URL = DEVNET_RPC;
process.env.VITE_SOLANA_RPC_URL = DEVNET_RPC;
// A 1 SOL migration threshold so one buy graduates the curve.
process.env.REALM_CURVE_MIGRATION_QUOTE = '1';

function loadDeployer(): Keypair {
  try {
    process.loadEnvFile('.env.local');
  } catch {
    // the variable may come from the shell
  }
  const raw = (process.env.SOLANA_DEVNET_DEPLOYER ?? '').trim();
  if (!raw) throw new Error('SOLANA_DEVNET_DEPLOYER is not set (see .env.local)');
  if (raw.startsWith('[')) return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(raw)));
  if (raw.startsWith('/') || raw.endsWith('.json')) {
    return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(raw, 'utf8'))));
  }
  return Keypair.fromSecretKey(bs58.decode(raw));
}

async function pollFinalized(conn: Connection, sig: string, timeoutMs = 150_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const res = await conn.getSignatureStatuses([sig], { searchTransactionHistory: true });
    const st = res.value[0];
    if (st?.err) throw new Error(`tx ${sig} failed on chain: ${JSON.stringify(st.err)}`);
    if (st?.confirmationStatus === 'finalized') return;
    if (Date.now() > deadline) throw new Error(`tx ${sig} not finalized within ${timeoutMs}ms`);
    await new Promise((r) => setTimeout(r, 2500));
  }
}

async function landBase64(conn: Connection, txBase64: string, signers: Keypair[]): Promise<string> {
  const tx = Transaction.from(Buffer.from(txBase64, 'base64'));
  tx.partialSign(...signers);
  const sig = await conn.sendRawTransaction(tx.serialize(), { skipPreflight: false });
  await pollFinalized(conn, sig);
  return sig;
}

async function landTx(
  conn: Connection,
  tx: Transaction,
  payer: Keypair,
  extraSigners: Keypair[] = [],
): Promise<string> {
  const { blockhash } = await conn.getLatestBlockhash('finalized');
  tx.recentBlockhash = blockhash;
  tx.feePayer = payer.publicKey;
  tx.sign(payer, ...extraSigners);
  const sig = await conn.sendRawTransaction(tx.serialize(), { skipPreflight: false });
  await pollFinalized(conn, sig);
  return sig;
}

function makeToken(realmId: number): RealmToken {
  return {
    realmId,
    mint: null,
    decimals: 9,
    symbol: 'CURVY',
    icon: '',
    status: 'funded',
    monetizationPolicy: 'cosmetic',
    curveAddress: null,
    poolAddress: null,
    lpLockAddress: null,
    feeClaimerPda: null,
    launchTxSig: null,
    distributeTxSig: null,
    supplyBase: null,
    founderAllocBase: null,
    levyAllocBase: null,
    treasuryAllocBase: null,
    founderLockAddress: null,
    levyLockAddress: null,
    treasuryLockAddress: null,
    createdAt: new Date(),
    updatedAt: new Date(),
  };
}

class MemTokens implements RealmTokenDb {
  rows = new Map<number, RealmToken>();
  async getRealmToken(realmId: number) {
    return this.rows.get(realmId) ?? null;
  }
  async insertRealmToken(): Promise<RealmToken> {
    throw new Error('unused');
  }
  async listRealmTokens() {
    return new Map<number, RealmToken>();
  }
  async setRealmTokenStatus(
    realmId: number,
    from: readonly RealmToken['status'][],
    to: RealmToken['status'],
  ) {
    const row = this.rows.get(realmId);
    if (!row || !from.includes(row.status)) return null;
    const next = { ...row, status: to };
    this.rows.set(realmId, next);
    return next;
  }
  async recordMintCreated() {
    return null;
  }
  async recordDistribution(
    realmId: number,
    d: {
      distributeTxSig: string;
      supplyBase: bigint;
      founderAllocBase: bigint;
      levyAllocBase: bigint;
      treasuryAllocBase: bigint;
    },
  ) {
    const row = this.rows.get(realmId);
    if (!row || row.distributeTxSig !== null || row.mint === null) return null;
    const next = { ...row, ...d };
    this.rows.set(realmId, next);
    return next;
  }
  async recordLockAddress(
    realmId: number,
    bucket: 'founder' | 'levy' | 'treasury',
    address: string,
  ) {
    const row = this.rows.get(realmId);
    if (!row || (row.distributeTxSig === null && row.curveAddress === null)) return null;
    const key =
      bucket === 'founder'
        ? ('founderLockAddress' as const)
        : bucket === 'levy'
          ? ('levyLockAddress' as const)
          : ('treasuryLockAddress' as const);
    if (row[key] !== null) return null;
    const next = { ...row, [key]: address };
    this.rows.set(realmId, next);
    return next;
  }
  async recordCurveLaunch(
    realmId: number,
    d: {
      mint: string;
      launchTxSig: string;
      curveAddress: string;
      poolAddress: string;
      feeClaimerPda: string;
      supplyBase: bigint;
      founderAllocBase: bigint;
      levyAllocBase: bigint;
      treasuryAllocBase: bigint;
    },
  ) {
    const row = this.rows.get(realmId);
    if (!row || row.mint !== null || row.curveAddress !== null || row.status !== 'funded')
      return null;
    const next = { ...row, ...d };
    this.rows.set(realmId, next);
    return next;
  }
  async recordLpLock(realmId: number, address: string) {
    const row = this.rows.get(realmId);
    if (!row || row.lpLockAddress !== null || row.poolAddress === null) return null;
    const next = { ...row, lpLockAddress: address };
    this.rows.set(realmId, next);
    return next;
  }
}

class MemQuotes implements LaunchQuoteStore {
  rows = new Map<string, LaunchQuoteRow>();
  async createQuote(q: LaunchQuoteRow) {
    this.rows.set(q.quoteId, q);
  }
  async getQuote(quoteId: string) {
    return this.rows.get(quoteId) ?? null;
  }
  async deleteQuote(quoteId: string) {
    this.rows.delete(quoteId);
  }
}

(RUN ? describe : describe.skip)('launchpad phase 4 on live devnet (Meteora DBC)', () => {
  it('curve launch -> trade to threshold -> graduate to DAMM v2 -> locks -> live', {
    timeout: 900_000,
  }, async () => {
    const curveMod = await import('../server/realm_token_curve');
    const mintMod = await import('../server/realm_token_mint');
    const { MeteoraDbcVenue } = await import('../server/realm_launchpad_dbc');
    const sdk = await import('@meteora-ag/dynamic-bonding-curve-sdk');
    const BN = (await import('bn.js')).default;

    const conn = new Connection(DEVNET_RPC, 'confirmed');
    const founder = loadDeployer();
    const founderPk = founder.publicKey.toBase58();
    const levyWallet = Keypair.generate().publicKey.toBase58();
    process.env.REALM_TOKEN_LEVY_WALLET = levyWallet;
    // The platform fee vault must be a PDA (off-curve); derive one under the
    // lock program for the dry-run.
    const feeClaimerPda = PublicKey.findProgramAddressSync(
      [Buffer.from('devnet_fee_vault')],
      new PublicKey('LocpQgucEQHbqNABEYvBvwoxCPsSbG91A1QaQhQQqjn'),
    )[0].toBase58();
    process.env.REALM_LAUNCHPAD_FEE_CLAIMER = feeClaimerPda;

    const venue = new MeteoraDbcVenue(DEVNET_RPC);
    const tokens = new MemTokens();
    tokens.rows.set(1, makeToken(1));
    const deps: CurveDeps = {
      tokens,
      quotes: new MemQuotes(),
      presales: { getPresale: async () => null },
      chain: mintMod.realLaunchChain(),
      venue,
      walletForAccount: async () => ({ pubkey: founderPk }),
      rolesForAccountOnRealm: async () => ['owner'],
      isUniqueViolation: () => false,
    };

    // 1. Launch: config + pool in one founder-signed transaction.
    const quote = await curveMod.prepareCurveQuote(deps, { accountId: 1, realmId: 1 });
    expect(quote.ok, 'curve quote').toBe(true);
    if (!quote.ok) return;
    const launchSig = await landBase64(conn, quote.quote.txBase64, [founder]);
    console.log(`devnet curve launch: https://explorer.solana.com/tx/${launchSig}?cluster=devnet`);
    const confirmed = await curveMod.confirmCurveLaunch(deps, {
      accountId: 1,
      quoteId: quote.quote.quoteId,
      signature: launchSig,
    });
    expect(confirmed, 'curve confirm (live on-chain config verified)').toMatchObject({ ok: true });
    const pool = quote.quote.poolAddress;
    const baseMint = quote.quote.baseMint;
    console.log(`devnet pool: https://explorer.solana.com/address/${pool}?cluster=devnet`);
    console.log(`devnet mint: https://explorer.solana.com/address/${baseMint}?cluster=devnet`);

    // The live state reads come from the chain: threshold == 1 SOL.
    let state = await curveMod.curveState(deps, 1);
    expect(state.ok).toBe(true);
    if (!state.ok) return;
    expect(state.curve.migrationQuoteThresholdBase).toBe((10n ** 9n).toString());
    expect(state.curve.isMigrated).toBe(false);

    // A fresh curve has no quote liquidity: a sale of one whole token is
    // ILLIQUID and quotes null (phase 6 excludes, never zeroes).
    expect(await venue.sellQuote(pool, 1_000_000_000n)).toBeNull();

    // 2. Trade through the curve to the threshold. The starting anti-snipe fee
    // is 20 percent, so 1.45 SOL in comfortably nets the 1 SOL reserve; the
    // program clamps the final swap at curve completion. A small first buy
    // seeds quote liquidity so the size-aware sell quote becomes real.
    const dbcClient = new sdk.DynamicBondingCurveClient(conn, 'confirmed');
    const buy = async (lamports: number) => {
      const swapTx = await dbcClient.pool.swap({
        owner: founder.publicKey,
        pool: new PublicKey(pool),
        amountIn: new BN(lamports),
        minimumAmountOut: new BN(0),
        swapBaseForQuote: false,
        referralTokenAccount: null,
      });
      const swapSig = await landTx(conn, swapTx, founder);
      console.log(
        `devnet swap ${lamports}: https://explorer.solana.com/tx/${swapSig}?cluster=devnet`,
      );
    };
    await buy(300_000_000);
    // Quote a MEANINGFUL size (1 percent of supply): one whole token against a
    // billion-token curve is sub-lamport dust and legitimately rounds to zero.
    const midQuote = await venue.sellQuote(pool, 10_000_000n * 10n ** 9n);
    expect(midQuote, 'size-aware sell quote on a live curve').not.toBeNull();
    expect(midQuote).toBeGreaterThan(0n);
    // The COMPLETING buy must be a partial-fill swap2: a plain exact-in swap
    // past the curve's remaining base liquidity reverts (InsufficientLiquidity).
    const finishTx = await dbcClient.pool.swap2({
      owner: founder.publicKey,
      pool: new PublicKey(pool),
      swapBaseForQuote: false,
      referralTokenAccount: null,
      swapMode: sdk.SwapMode.PartialFill,
      amountIn: new BN(1_400_000_000),
      minimumAmountOut: new BN(0),
    });
    const finishSig = await landTx(conn, finishTx, founder);
    console.log(
      `devnet completing swap: https://explorer.solana.com/tx/${finishSig}?cluster=devnet`,
    );

    state = await curveMod.curveState(deps, 1);
    expect(state.ok).toBe(true);
    if (!state.ok) return;
    expect(state.curve.progressBps, 'curve completed').toBe(10_000);

    // 3. Graduate: createLocker (the founder vesting escrow), then the DAMM v2
    // migration with the permanently locked LP. Both are permissionless cranks.
    const lockerTx = await venue.buildCreateLockerTx(pool, founderPk);
    const lockerSig = await landTx(conn, lockerTx, founder);
    console.log(`devnet createLocker: https://explorer.solana.com/tx/${lockerSig}?cluster=devnet`);
    const migrate = await venue.buildMigrateToDammV2Tx(pool, founderPk);
    const migrateSig = await landTx(conn, migrate.transaction, founder, migrate.signers);
    console.log(`devnet migrate: https://explorer.solana.com/tx/${migrateSig}?cluster=devnet`);

    // 4. Reconcile: the founder-vesting locker escrow decodes with the SAME
    // phase-3 verifier, the DAMM v2 pool exists, both get recorded.
    let reconciled = await curveMod.reconcileCurve(deps, { accountId: 1, realmId: 1 });
    expect(reconciled, 'reconcile after migration').toMatchObject({ ok: true });
    if (!reconciled.ok) return;
    expect(reconciled.founderLock, 'founder locker recorded').not.toBeNull();
    expect(reconciled.lpLock, 'DAMM v2 LP lock recorded').not.toBeNull();
    console.log(`founder vesting escrow: ${reconciled.founderLock}`);
    console.log(`DAMM v2 pool (permanent LP): ${reconciled.lpLock}`);
    // The levy lock does not exist yet: the gate holds.
    expect(reconciled.status).toBe('funded');

    // 5. Withdraw the leftover (levy + treasury buckets) to the founder.
    const leftoverQuote = await curveMod.prepareLeftoverQuote(deps, { accountId: 1, realmId: 1 });
    expect(leftoverQuote.ok, 'leftover quote').toBe(true);
    if (!leftoverQuote.ok) return;
    const leftoverSig = await landBase64(conn, leftoverQuote.quote.txBase64, [founder]);
    console.log(`devnet leftover: https://explorer.solana.com/tx/${leftoverSig}?cluster=devnet`);
    const leftoverConfirm = await curveMod.confirmLeftover(deps, {
      accountId: 1,
      quoteId: leftoverQuote.quote.quoteId,
      signature: leftoverSig,
    });
    expect(leftoverConfirm, 'leftover confirm (exact delta)').toMatchObject({ ok: true });

    // 6. Lock levy + treasury through the UNCHANGED phase-3 flow.
    for (const bucket of ['levy', 'treasury'] as const) {
      const lockQuote = await mintMod.prepareLockQuote(deps, {
        accountId: 1,
        realmId: 1,
        bucket,
      });
      expect(lockQuote.ok, `${bucket} lock quote`).toBe(true);
      if (!lockQuote.ok) return;
      const lockSig = await landBase64(conn, lockQuote.quote.txBase64, [founder]);
      console.log(
        `devnet ${bucket} lock ${lockQuote.quote.escrow}: https://explorer.solana.com/tx/${lockSig}?cluster=devnet`,
      );
      const lockConfirm = await mintMod.confirmLock(deps, {
        accountId: 1,
        quoteId: lockQuote.quote.quoteId,
      });
      expect(lockConfirm, `${bucket} lock confirm`).toMatchObject({ ok: true, bucket });
    }

    // 7. Reconcile again: every lock is now verifiably on-chain, so the token
    // walks through the ONLY door to 'live' and on to 'graduated'.
    reconciled = await curveMod.reconcileCurve(deps, { accountId: 1, realmId: 1 });
    expect(reconciled).toMatchObject({ ok: true, status: 'graduated' });

    const finalState = await curveMod.curveState(deps, 1);
    expect(finalState.ok).toBe(true);
    if (finalState.ok) {
      expect(finalState.curve.isMigrated).toBe(true);
      console.log('final curve state:', JSON.stringify(finalState.curve, null, 2));
    }
    const row = tokens.rows.get(1);
    console.log(
      'final registry row:',
      JSON.stringify(
        {
          status: row?.status,
          mint: row?.mint,
          curve: row?.curveAddress,
          pool: row?.poolAddress,
          founderLock: row?.founderLockAddress,
          levyLock: row?.levyLockAddress,
          treasuryLock: row?.treasuryLockAddress,
          lpLock: row?.lpLockAddress,
        },
        null,
        2,
      ),
    );
  });
});
