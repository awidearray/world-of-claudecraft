// Live-devnet dry-run for launchpad phase 3 (the acceptance check): drives the
// REAL production code paths (prepareMintQuote / confirmMintCreated /
// prepareDistributionQuote / confirmDistribution / prepareLockQuote /
// confirmLock / markTokenLive) against the real devnet chain, the real
// Token-2022 program, and the real deployed Jupiter Lock program. The founder
// is the funded devnet deployer keypair (SOLANA_DEVNET_DEPLOYER in .env.local:
// a path to a JSON keypair, a base58 secret, or an inline JSON array; never
// committed, never printed). Everything the server would verify is verified
// here by the same functions the server runs.
//
// Gated on WOC_DEVNET_TEST=1 (skipped in CI and normal runs):
//   WOC_DEVNET_TEST=1 npx vitest run tests/realm_token_mint.devnet.test.ts
//
// Confirmations are HTTP-polled (getSignatureStatuses), never websocket
// subscriptions, which hang under vitest.

import { readFileSync } from 'node:fs';
import { Connection, Keypair, Transaction } from '@solana/web3.js';
import bs58 from 'bs58';
import { describe, expect, it } from 'vitest';
import type { RealmToken, RealmTokenDb } from '../server/realm_token';
import type { LaunchDeps, LaunchQuoteRow, LaunchQuoteStore } from '../server/realm_token_mint';

const RUN = process.env.WOC_DEVNET_TEST === '1';
const DEVNET_RPC = 'https://api.devnet.solana.com';

// The server modules read SOLANA_RPC_URL at import time, so it must point at
// devnet BEFORE any dynamic import below (static imports above are types only,
// plus vitest/web3.js/node which never read it).
process.env.SOLANA_RPC_URL = DEVNET_RPC;
process.env.VITE_SOLANA_RPC_URL = DEVNET_RPC;

function loadDeployer(): Keypair {
  try {
    process.loadEnvFile('.env.local');
  } catch {
    // fine: the variable may come from the shell
  }
  const raw = (process.env.SOLANA_DEVNET_DEPLOYER ?? '').trim();
  if (!raw) throw new Error('SOLANA_DEVNET_DEPLOYER is not set (see .env.local)');
  if (raw.startsWith('[')) return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(raw)));
  if (raw.startsWith('/') || raw.endsWith('.json')) {
    return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(raw, 'utf8'))));
  }
  return Keypair.fromSecretKey(bs58.decode(raw));
}

// HTTP-poll a signature to finalization.
async function pollFinalized(conn: Connection, sig: string, timeoutMs = 120_000): Promise<void> {
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

async function signAndLand(conn: Connection, txBase64: string, founder: Keypair): Promise<string> {
  const tx = Transaction.from(Buffer.from(txBase64, 'base64'));
  tx.partialSign(founder);
  const sig = await conn.sendRawTransaction(tx.serialize(), { skipPreflight: false });
  await pollFinalized(conn, sig);
  return sig;
}

// Minimal in-memory stores (the SQL layer is covered by the integration suite;
// this dry-run is about the CHAIN).
function makeToken(realmId: number): RealmToken {
  return {
    realmId,
    mint: null,
    decimals: 9,
    symbol: 'DRYRUN',
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
  async recordMintCreated(realmId: number, mint: string, launchTxSig: string) {
    const row = this.rows.get(realmId);
    if (!row || row.mint !== null || row.status !== 'funded') return null;
    const next = { ...row, mint, launchTxSig };
    this.rows.set(realmId, next);
    return next;
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
    if (!row || row.distributeTxSig === null) return null;
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
  async listByStatus(): Promise<Array<RealmToken & { realmName: string }>> {
    throw new Error('listByStatus is not exercised by this suite');
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

(RUN ? describe : describe.skip)('launchpad phase 3 on live devnet', () => {
  it('mint -> distribute + renounce -> three immutable Jupiter Locks, all server-verified', {
    timeout: 900_000,
  }, async () => {
    const mintMod = await import('../server/realm_token_mint');
    const t22 = await import('../server/solana_token2022');
    const rpc = await import('../server/solana_rpc');

    const conn = new Connection(DEVNET_RPC, 'confirmed');
    const founder = loadDeployer();
    // Throwaway receipt-only wallets: the presale escrow (receives the curve
    // + liquidity buckets) and the platform levy fund.
    const escrowWallet = Keypair.generate().publicKey;
    const levyWallet = Keypair.generate().publicKey;
    process.env.REALM_TOKEN_LEVY_WALLET = levyWallet.toBase58();

    const tokens = new MemTokens();
    tokens.rows.set(1, makeToken(1));
    const deps: LaunchDeps = {
      tokens,
      quotes: new MemQuotes(),
      presales: {
        getPresale: async () => ({
          realmId: 1,
          escrowWallet: escrowWallet.toBase58(),
          rails: {},
          createdAt: new Date(),
        }),
      },
      chain: mintMod.realLaunchChain(),
      walletForAccount: async () => ({ pubkey: founder.publicKey.toBase58() }),
      rolesForAccountOnRealm: async () => ['owner'],
      isUniqueViolation: () => false,
    };

    // Step 1: create the Token-2022 mint (server-built, founder co-signed).
    const mintQuote = await mintMod.prepareMintQuote(deps, { accountId: 1, realmId: 1 });
    expect(mintQuote.ok, 'mint quote').toBe(true);
    if (!mintQuote.ok) return;
    const createSig = await signAndLand(conn, mintQuote.quote.txBase64, founder);
    console.log(`devnet mint create: https://explorer.solana.com/tx/${createSig}?cluster=devnet`);
    const mintConfirm = await mintMod.confirmMintCreated(deps, {
      accountId: 1,
      quoteId: mintQuote.quote.quoteId,
      signature: createSig,
    });
    expect(mintConfirm, 'mint confirm').toMatchObject({ ok: true, mint: mintQuote.quote.mint });
    const mint = mintQuote.quote.mint;
    console.log(`devnet mint: https://explorer.solana.com/address/${mint}?cluster=devnet`);

    // The scoped verifier sees a clean pre-distribution mint (authority
    // still with the founder until the distribute step renounces it).
    const created = await t22.fetchParsedMint(mint);
    expect(created?.program).toBe('spl-token-2022');
    expect(created?.decimals).toBe(9);
    expect(created?.freezeAuthority).toBeNull();
    expect(created?.metadata?.symbol).toBe('DRYRUN');

    // Step 2: distribute the fixed supply + renounce, one atomic tx.
    const distQuote = await mintMod.prepareDistributionQuote(deps, { accountId: 1, realmId: 1 });
    expect(distQuote.ok, 'distribution quote').toBe(true);
    if (!distQuote.ok) return;
    const distSig = await signAndLand(conn, distQuote.quote.txBase64, founder);
    console.log(`devnet distribute: https://explorer.solana.com/tx/${distSig}?cluster=devnet`);
    const distConfirm = await mintMod.confirmDistribution(deps, {
      accountId: 1,
      quoteId: distQuote.quote.quoteId,
      signature: distSig,
    });
    expect(distConfirm, 'distribution confirm').toMatchObject({ ok: true });

    // RugCheck-style acceptance: renounced everything, boring extensions.
    const parsed = await t22.fetchParsedMint(mint);
    expect(parsed).not.toBeNull();
    const summary = t22.mintRugSummary(mint, parsed as NonNullable<typeof parsed>);
    expect(summary, 'rug summary').toMatchObject({
      isToken2022: true,
      mintAuthorityNull: true,
      freezeAuthorityNull: true,
      metadataPresent: true,
      metadataImmutable: true,
      metadataPointerSelf: true,
      forbiddenExtensions: [],
      clean: true,
    });

    // The LEGACY verifier core still rejects this Token-2022 mint outright:
    // the same finalized distribution tx trips the buy/presale-path guard.
    const rawDist = await rpc.fetchFinalizedTransaction(distSig);
    expect(rawDist).not.toBeNull();
    const legacy = rpc.parseSplitPayment(rawDist as NonNullable<typeof rawDist>, mint);
    expect(legacy.usesToken2022ForMint, 'legacy parser rejects Token-2022').toBe(true);

    // Step 3: the three immutable Jupiter Lock escrows.
    for (const bucket of ['founder', 'levy', 'treasury'] as const) {
      const lockQuote = await mintMod.prepareLockQuote(deps, {
        accountId: 1,
        realmId: 1,
        bucket,
      });
      expect(lockQuote.ok, `${bucket} lock quote`).toBe(true);
      if (!lockQuote.ok) return;
      const lockSig = await signAndLand(conn, lockQuote.quote.txBase64, founder);
      console.log(
        `devnet ${bucket} lock ${lockQuote.quote.escrow}: https://explorer.solana.com/tx/${lockSig}?cluster=devnet`,
      );
      const lockConfirm = await mintMod.confirmLock(deps, {
        accountId: 1,
        quoteId: lockQuote.quote.quoteId,
      });
      expect(lockConfirm, `${bucket} lock confirm`).toMatchObject({
        ok: true,
        bucket,
        escrow: lockQuote.quote.escrow,
      });
    }

    // The listing gate: still blocked (no LP lock until phase 4)...
    expect(await mintMod.markTokenLive(deps, 1)).toMatchObject({
      ok: false,
      error: 'locks_incomplete',
    });
    // ...and opens exactly when the LP lock exists too.
    const row = tokens.rows.get(1) as RealmToken;
    tokens.rows.set(1, { ...row, lpLockAddress: 'LpLockPlaceholder' });
    expect(await mintMod.markTokenLive(deps, 1)).toMatchObject({ ok: true, status: 'live' });

    const status = await mintMod.launchStatus(deps, 1);
    expect(status.ok).toBe(true);
    if (status.ok) {
      console.log('final launch status:', JSON.stringify(status.launch, null, 2));
    }
  });
});
