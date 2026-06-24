// On-chain shakeout for the ad marketplace (USDC / SOL / WOC pay + deferred burn
// + refund) against a REAL Solana RPC — defaults to a local validator, which is
// the reliable choice (instant airdrops, fast finality). All keypairs are
// throwaway TEST keys and all mints are TEST mints; nothing here touches real
// funds or mainnet.
//
// Prereqs:
//   • A Solana RPC with funding. Easiest: `solana-test-validator` (RPC at
//     http://127.0.0.1:8899). Public devnet works too IF its faucet isn't 429ing.
//   • A Postgres reachable via DATABASE_URL (e.g. `npm run db:up`, or an
//     ephemeral `docker run postgres`).
//   • The server bundle is built automatically (esbuild) if missing.
//
// Run:
//   SOLANA_RPC_URL=http://127.0.0.1:8899 \
//   DATABASE_URL=postgres://eastbrook:test@127.0.0.1:5433/eastbrook \
//   node scripts/ad_devnet_shakeout.mjs
//
// It generates a keeper (treasury) + buyer, funds them, creates test USDC/WOC
// mints, boots the server wired to those, then drives: WOC pay→confirm→approve→
// deferred burn; USDC pay→confirm→reject→refund; native-SOL pay→confirm. Each
// step asserts on-chain balances + DB state and prints PASS/FAIL.
import { Connection, Keypair, LAMPORTS_PER_SOL, PublicKey, SystemProgram, Transaction, TransactionInstruction } from '@solana/web3.js';
import {
  createMint, getOrCreateAssociatedTokenAccount, mintTo, getAssociatedTokenAddressSync,
  createAssociatedTokenAccountIdempotentInstruction, createTransferCheckedInstruction,
} from '@solana/spl-token';
import { ed25519 } from '@noble/curves/ed25519';
import bs58 from 'bs58';
import { spawn, execFileSync } from 'node:child_process';
import { randomBytes, scryptSync } from 'node:crypto';
import pg from 'pg';

const RPC = process.env.SOLANA_RPC_URL ?? 'http://127.0.0.1:8899';
const DATABASE_URL = process.env.DATABASE_URL;
const PORT = Number(process.env.PORT ?? 8810);
const BASE = `http://127.0.0.1:${PORT}`;
const MEMO = new PublicKey('MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr');
if (!DATABASE_URL) { console.error('set DATABASE_URL'); process.exit(1); }

const conn = new Connection(RPC, 'confirmed');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let passes = 0, fails = 0;
const check = (label, ok) => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}`); ok ? passes++ : fails++; };

async function fund(kp, sol) {
  const sig = await conn.requestAirdrop(kp.publicKey, sol * LAMPORTS_PER_SOL);
  const bh = await conn.getLatestBlockhash();
  await conn.confirmTransaction({ signature: sig, ...bh }, 'confirmed');
}
async function sendAs(payer, ixs) {
  const bh = await conn.getLatestBlockhash('finalized');
  const tx = new Transaction({ feePayer: payer.publicKey, ...bh }).add(...ixs);
  tx.sign(payer);
  const sig = await conn.sendRawTransaction(tx.serialize());
  await conn.confirmTransaction({ signature: sig, ...bh }, 'finalized');
  return sig;
}
const memoIx = (s) => new TransactionInstruction({ programId: MEMO, keys: [], data: Buffer.from(s, 'utf8') });
const j = async (r) => ({ status: r.status, body: await r.json().catch(() => null) });
const post = (p, b, tok) => fetch(BASE + p, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(tok ? { Authorization: `Bearer ${tok}` } : {}) }, body: JSON.stringify(b) }).then(j);

async function advertiserToken(buyer) {
  const pubkey = buyer.publicKey.toBase58();
  const ch = await post('/api/ads/advertiser/challenge', { pubkey });
  const sig = bs58.encode(ed25519.sign(new TextEncoder().encode(ch.body.message), buyer.secretKey.slice(0, 32)));
  const auth = await post('/api/ads/advertiser/auth', { pubkey, signature: sig, nonce: ch.body.nonce });
  return auth.body.token;
}
function alignedStart(minAhead) {
  const now = Math.floor(Date.now() / 1000);
  return (Math.floor(now / 60) + minAhead) * 60 * 1000; // epoch ms, minute-aligned
}

async function main() {
  console.log(`RPC=${RPC}`);
  const keeper = Keypair.generate();
  const buyer = Keypair.generate();
  console.log('keeper(treasury):', keeper.publicKey.toBase58());
  console.log('buyer           :', buyer.publicKey.toBase58());
  await fund(keeper, 5);
  await fund(buyer, 5);

  // Test mints (6 decimals, keeper is mint authority).
  const usdc = await createMint(conn, keeper, keeper.publicKey, null, 6);
  const woc = await createMint(conn, keeper, keeper.publicKey, null, 6);
  console.log('USDC test mint  :', usdc.toBase58());
  console.log('WOC  test mint  :', woc.toBase58());
  const buyerUsdc = await getOrCreateAssociatedTokenAccount(conn, buyer, usdc, buyer.publicKey);
  const buyerWoc = await getOrCreateAssociatedTokenAccount(conn, buyer, woc, buyer.publicKey);
  await mintTo(conn, keeper, usdc, buyerUsdc.address, keeper, 100_000_000_000n); // 100k USDC
  await mintTo(conn, keeper, woc, buyerWoc.address, keeper, 100_000_000_000n); // 100k WOC

  // Build + boot the server wired to the test mints + keeper treasury.
  execFileSync('npx', ['esbuild', 'server/main.ts', '--bundle', '--platform=node', '--format=cjs',
    '--external:pg-native', '--external:bufferutil', '--external:utf-8-validate', '--outfile=dist-server/server.cjs'], { stdio: 'ignore' });
  const env = {
    ...process.env, DATABASE_URL, PORT: String(PORT), SOLANA_RPC_URL: RPC,
    AD_MARKET_ENABLED: 'true', AD_REFUND_ENABLED: 'true',
    USDC_MINT: usdc.toBase58(), WOC_MINT: woc.toBase58(),
    AD_USDC_TREASURY: keeper.publicKey.toBase58(), AD_SOL_TREASURY: keeper.publicKey.toBase58(), AD_WOC_TREASURY: keeper.publicKey.toBase58(),
    AD_REFUND_KEEPER_SECRET: bs58.encode(keeper.secretKey),
    WOC_AD_BURN_BPS: '5000', AD_MIN_LEAD_MINUTES: '1',
    AD_PRICE_PER_MIN_USDC: '1', AD_PRICE_PER_MIN_SOL: '0.01', AD_PRICE_PER_MIN_WOC: '100',
  };
  const server = spawn('node', ['dist-server/server.cjs'], { env, stdio: 'inherit' });
  await sleep(4000);

  // Admin account + token straight into the DB.
  const db = new pg.Pool({ connectionString: DATABASE_URL });
  // Reset the ad domain so the shakeout is repeatable against a reused DB.
  await db.query('TRUNCATE ad_refunds, ad_payments, ad_quotes, ad_bookings, ad_creatives, advertiser_tokens, advertiser_challenges, advertisers RESTART IDENTITY CASCADE');
  const salt = randomBytes(16), key = scryptSync('x', salt, 64, { N: 16384, r: 8, p: 1 });
  const adminUser = `shakeout_admin_${randomBytes(4).toString('hex')}`;
  const acc = await db.query(`INSERT INTO accounts (username, password_hash, is_admin) VALUES ($1, $2, TRUE) RETURNING id`,
    [adminUser, `${salt.toString('hex')}:${key.toString('hex')}`]);
  const adminTok = randomBytes(32).toString('hex');
  await db.query(`INSERT INTO auth_tokens (token, account_id, expires_at) VALUES ($1, $2, now() + interval '1 day')`, [adminTok, acc.rows[0].id]);

  const tok = await advertiserToken(buyer);

  // ── WOC: pay → confirm → approve → deferred burn ──
  {
    const cre = await post('/api/ads/creative', { text: 'Acme Forge — finest blades', cta: 'Get the App', clickUrl: 'https://example.com' }, tok);
    const startsAt = alignedStart(2);
    const reserve = await post('/api/ads/reserve', { placement: 'ticker', asset: 'WOC', startsAt, minutes: 2, creativeId: cre.body.creativeId }, tok);
    const quote = await post('/api/ads/quote', { bookingId: reserve.body.bookingId }, tok);
    const amount = BigInt(quote.body.amountBase);
    const keeperWoc = getAssociatedTokenAddressSync(woc, keeper.publicKey);
    const sig = await sendAs(buyer, [
      createAssociatedTokenAccountIdempotentInstruction(buyer.publicKey, keeperWoc, keeper.publicKey, woc),
      createTransferCheckedInstruction(buyerWoc.address, woc, keeperWoc, buyer.publicKey, amount, 6),
      memoIx(quote.body.memo),
    ]);
    const confirm = await post('/api/ads/confirm', { quoteId: quote.body.quoteId, signature: sig }, tok);
    console.log('  [debug] WOC payment sig', sig, '→ confirm', confirm.status, JSON.stringify(confirm.body));
    check('WOC confirm → pending_review', confirm.body?.status === 'pending_review');
    const keeperWocBefore = BigInt((await conn.getTokenAccountBalance(keeperWoc)).value.amount);
    const ap = await post(`/admin/api/ads/creatives/${cre.body.creativeId}/approve`, {}, adminTok);
    await sleep(1500);
    const keeperWocAfter = BigInt((await conn.getTokenAccountBalance(keeperWoc)).value.amount);
    const burned = keeperWocBefore - keeperWocAfter;
    check(`WOC deferred burn on approve (burned ${burned} = 50% of ${amount})`, ap.body?.data?.results?.[0]?.burn === 'burned' && burned === amount / 2n);
  }

  // ── USDC: pay → confirm → reject → refund ──
  {
    const cre = await post('/api/ads/creative', { text: 'ClaudeCoffee — 20% off', cta: 'Claim', clickUrl: 'https://example.com' }, tok);
    const startsAt = alignedStart(3);
    const reserve = await post('/api/ads/reserve', { placement: 'classifieds', asset: 'USDC', startsAt, minutes: 2, creativeId: cre.body.creativeId }, tok);
    const quote = await post('/api/ads/quote', { bookingId: reserve.body.bookingId }, tok);
    const amount = BigInt(quote.body.amountBase);
    const keeperUsdc = getAssociatedTokenAddressSync(usdc, keeper.publicKey);
    const sig = await sendAs(buyer, [
      createAssociatedTokenAccountIdempotentInstruction(buyer.publicKey, keeperUsdc, keeper.publicKey, usdc),
      createTransferCheckedInstruction(buyerUsdc.address, usdc, keeperUsdc, buyer.publicKey, amount, 6),
      memoIx(quote.body.memo),
    ]);
    await post('/api/ads/confirm', { quoteId: quote.body.quoteId, signature: sig }, tok);
    const buyerBefore = BigInt((await conn.getTokenAccountBalance(buyerUsdc.address)).value.amount);
    const rej = await post(`/admin/api/ads/creatives/${cre.body.creativeId}/reject`, {}, adminTok);
    await sleep(1500);
    const buyerAfter = BigInt((await conn.getTokenAccountBalance(buyerUsdc.address)).value.amount);
    check(`USDC refund on reject (refunded ${buyerAfter - buyerBefore} = ${amount})`, rej.body?.data?.results?.[0]?.refund === 'refunded' && buyerAfter - buyerBefore === amount);
  }

  // ── native SOL: pay → confirm (proves lamport-delta verify on real chain) ──
  {
    const cre = await post('/api/ads/creative', { text: 'Realm News — read all about it', clickUrl: '' }, tok);
    const startsAt = alignedStart(4);
    const reserve = await post('/api/ads/reserve', { placement: 'ticker', asset: 'SOL', startsAt, minutes: 2, creativeId: cre.body.creativeId }, tok);
    const quote = await post('/api/ads/quote', { bookingId: reserve.body.bookingId }, tok);
    const amount = BigInt(quote.body.amountBase);
    const sig = await sendAs(buyer, [
      SystemProgram.transfer({ fromPubkey: buyer.publicKey, toPubkey: keeper.publicKey, lamports: amount }),
      memoIx(quote.body.memo),
    ]);
    const confirm = await post('/api/ads/confirm', { quoteId: quote.body.quoteId, signature: sig }, tok);
    check('native SOL confirm → pending_review', confirm.body?.status === 'pending_review');
    const replay = await post('/api/ads/confirm', { quoteId: quote.body.quoteId, signature: sig }, tok);
    check('replay of used quote rejected', replay.status >= 400);
  }

  console.log(`\n${passes} passed, ${fails} failed`);
  await db.end();
  server.kill();
  process.exit(fails === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
