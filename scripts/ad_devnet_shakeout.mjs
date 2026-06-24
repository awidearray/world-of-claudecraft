// On-chain shakeout for the ad marketplace (USDC / SOL / $WOC pay + deferred burn
// + refund) against a REAL Solana cluster. Drives every transaction type the
// system produces and records each signature (→ Solscan links).
//
// Funding: if SOLANA_DEVNET_DEPLOYER is set (a funded base58 devnet keypair secret
// in .env.local — see CLAUDE.md), test keypairs are funded by transfer from it and
// the run targets devnet. Otherwise it airdrops (works on a local validator).
//
// Run (devnet):  node scripts/ad_devnet_shakeout.mjs
//   reads .env.local for SOLANA_DEVNET_DEPLOYER; needs DATABASE_URL (e.g. an
//   ephemeral Postgres). Writes /tmp/ad_devnet_txs.json with {label, sig}.
//
// Run (local validator):
//   SOLANA_RPC_URL=http://127.0.0.1:8899 DATABASE_URL=… node scripts/ad_devnet_shakeout.mjs
import { Connection, Keypair, LAMPORTS_PER_SOL, PublicKey, SystemProgram, Transaction, TransactionInstruction } from '@solana/web3.js';
import {
  createMint, getOrCreateAssociatedTokenAccount, mintTo, getAssociatedTokenAddressSync,
  createAssociatedTokenAccountIdempotentInstruction, createTransferCheckedInstruction,
} from '@solana/spl-token';
import { ed25519 } from '@noble/curves/ed25519';
import bs58 from 'bs58';
import { spawn, execFileSync } from 'node:child_process';
import { randomBytes, scryptSync } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import pg from 'pg';

try { process.loadEnvFile('.env.local'); } catch { /* optional */ }
const DEPLOYER_SECRET = process.env.SOLANA_DEVNET_DEPLOYER?.trim();
const deployer = DEPLOYER_SECRET ? Keypair.fromSecretKey(bs58.decode(DEPLOYER_SECRET)) : null;
const RPC = process.env.SOLANA_RPC_URL ?? (deployer ? 'https://api.devnet.solana.com' : 'http://127.0.0.1:8899');
const CLUSTER = RPC.includes('devnet') ? 'devnet' : RPC.includes('mainnet') ? 'mainnet' : 'custom';
const DATABASE_URL = process.env.DATABASE_URL;
const PORT = Number(process.env.PORT ?? 8810);
const BASE = `http://127.0.0.1:${PORT}`;
const MEMO = new PublicKey('MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr');
if (!DATABASE_URL) { console.error('set DATABASE_URL'); process.exit(1); }

const conn = new Connection(RPC, 'confirmed');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let passes = 0, fails = 0;
const check = (label, ok) => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}`); ok ? passes++ : fails++; };
const TXS = [];
const record = (label, sig) => { if (sig) { TXS.push({ label, sig }); console.log(`  tx[${label}] ${sig}`); } };

async function fund(kp, sol) {
  if (deployer) {
    const sig = await sendAs(deployer, [SystemProgram.transfer({ fromPubkey: deployer.publicKey, toPubkey: kp.publicKey, lamports: Math.floor(sol * LAMPORTS_PER_SOL) })]);
    return sig;
  }
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

// /confirm can 409 (not_finalized) on a real cluster before finality propagates;
// retry a few times. This mirrors robust client behaviour.
async function confirmWithRetry(quoteId, sig, tok) {
  for (let i = 0; i < 10; i++) {
    const r = await post('/api/ads/confirm', { quoteId, signature: sig }, tok);
    if (r.status === 200 || (r.body?.reason && r.body.reason !== 'not_finalized')) return r;
    await sleep(4000);
  }
  return post('/api/ads/confirm', { quoteId, signature: sig }, tok);
}

async function advertiserToken(buyer) {
  const pubkey = buyer.publicKey.toBase58();
  const ch = await post('/api/ads/advertiser/challenge', { pubkey });
  const sig = bs58.encode(ed25519.sign(new TextEncoder().encode(ch.body.message), buyer.secretKey.slice(0, 32)));
  const auth = await post('/api/ads/advertiser/auth', { pubkey, signature: sig, nonce: ch.body.nonce });
  return auth.body.token;
}
const alignedStart = (minAhead) => (Math.floor(Math.floor(Date.now() / 1000) / 60) + minAhead) * 60 * 1000;

async function main() {
  console.log(`cluster=${CLUSTER} RPC=${RPC}`);
  if (deployer) console.log('deployer:', deployer.publicKey.toBase58(), '(funder)');
  const keeper = Keypair.generate();
  const buyer = Keypair.generate();
  console.log('keeper(treasury):', keeper.publicKey.toBase58());
  console.log('buyer           :', buyer.publicKey.toBase58());
  await fund(keeper, deployer ? 1.5 : 5);
  await fund(buyer, deployer ? 1.5 : 5);

  const usdc = await createMint(conn, deployer ?? keeper, keeper.publicKey, null, 6);
  const woc = await createMint(conn, deployer ?? keeper, keeper.publicKey, null, 6);
  console.log('USDC test mint  :', usdc.toBase58());
  console.log('WOC  test mint  :', woc.toBase58());
  const buyerUsdc = await getOrCreateAssociatedTokenAccount(conn, deployer ?? buyer, usdc, buyer.publicKey);
  const buyerWoc = await getOrCreateAssociatedTokenAccount(conn, deployer ?? buyer, woc, buyer.publicKey);
  await mintTo(conn, deployer ?? keeper, usdc, buyerUsdc.address, keeper, 100_000_000_000n);
  await mintTo(conn, deployer ?? keeper, woc, buyerWoc.address, keeper, 100_000_000_000n);

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
  await sleep(5000);

  const db = new pg.Pool({ connectionString: DATABASE_URL });
  await db.query('TRUNCATE ad_refunds, ad_payments, ad_quotes, ad_bookings, ad_creatives, advertiser_tokens, advertiser_challenges, advertisers RESTART IDENTITY CASCADE');
  const salt = randomBytes(16), key = scryptSync('x', salt, 64, { N: 16384, r: 8, p: 1 });
  const acc = await db.query(`INSERT INTO accounts (username, password_hash, is_admin) VALUES ($1, $2, TRUE) RETURNING id`,
    [`shakeout_admin_${randomBytes(4).toString('hex')}`, `${salt.toString('hex')}:${key.toString('hex')}`]);
  const adminTok = randomBytes(32).toString('hex');
  await db.query(`INSERT INTO auth_tokens (token, account_id, expires_at) VALUES ($1, $2, now() + interval '1 day')`, [adminTok, acc.rows[0].id]);
  const tok = await advertiserToken(buyer);

  const buyAndConfirm = async (placement, asset, mint, srcAta, decimals, lead) => {
    const cre = await post('/api/ads/creative', { text: `Test ${asset} ad`, cta: 'Get the App', clickUrl: 'https://example.com' }, tok);
    const reserve = await post('/api/ads/reserve', { placement, asset, startsAt: alignedStart(lead), minutes: 2, creativeId: cre.body.creativeId }, tok);
    const quote = await post('/api/ads/quote', { bookingId: reserve.body.bookingId }, tok);
    const amount = BigInt(quote.body.amountBase);
    let sig;
    if (asset === 'SOL') {
      sig = await sendAs(buyer, [SystemProgram.transfer({ fromPubkey: buyer.publicKey, toPubkey: keeper.publicKey, lamports: amount }), memoIx(quote.body.memo)]);
    } else {
      const keeperAta = getAssociatedTokenAddressSync(mint, keeper.publicKey);
      sig = await sendAs(buyer, [
        createAssociatedTokenAccountIdempotentInstruction(buyer.publicKey, keeperAta, keeper.publicKey, mint),
        createTransferCheckedInstruction(srcAta, mint, keeperAta, buyer.publicKey, amount, decimals), memoIx(quote.body.memo),
      ]);
    }
    record(`${asset} pay`, sig);
    const confirm = await confirmWithRetry(quote.body.quoteId, sig, tok);
    return { creativeId: cre.body.creativeId, bookingId: reserve.body.bookingId, amount, confirm };
  };

  // ── WOC: pay → confirm → approve → deferred burn ──
  {
    const r = await buyAndConfirm('ticker', 'WOC', woc, buyerWoc.address, 6, 2);
    check('WOC pay confirmed → pending_review', r.confirm.body?.status === 'pending_review');
    const ap = await post(`/admin/api/ads/creatives/${r.creativeId}/approve`, {}, adminTok);
    await sleep(deployer ? 6000 : 1500);
    const burnSig = (await db.query('SELECT burn_sig FROM ad_bookings WHERE id=$1', [r.bookingId])).rows[0]?.burn_sig;
    record('WOC deferred burn', burnSig && burnSig !== 'pending' ? burnSig : null);
    check('WOC deferred burn executed', ap.body?.data?.results?.[0]?.burn === 'burned' && !!burnSig && burnSig !== 'pending');
  }

  // ── USDC: pay → confirm → reject → refund ──
  {
    const r = await buyAndConfirm('classifieds', 'USDC', usdc, buyerUsdc.address, 6, 3);
    check('USDC pay confirmed → pending_review', r.confirm.body?.status === 'pending_review');
    const rej = await post(`/admin/api/ads/creatives/${r.creativeId}/reject`, {}, adminTok);
    await sleep(deployer ? 6000 : 1500);
    const refundSig = (await db.query('SELECT refund_sig FROM ad_refunds WHERE booking_id=$1', [r.bookingId])).rows[0]?.refund_sig;
    record('USDC refund', refundSig);
    check('USDC refund executed', rej.body?.data?.results?.[0]?.refund === 'refunded' && !!refundSig);
  }

  // ── native SOL: pay → confirm → reject → refund ──
  {
    const r = await buyAndConfirm('classifieds', 'SOL', null, null, 9, 5);
    check('SOL pay confirmed → pending_review', r.confirm.body?.status === 'pending_review');
    const rej = await post(`/admin/api/ads/creatives/${r.creativeId}/reject`, {}, adminTok);
    await sleep(deployer ? 6000 : 1500);
    const refundSig = (await db.query('SELECT refund_sig FROM ad_refunds WHERE booking_id=$1', [r.bookingId])).rows[0]?.refund_sig;
    record('SOL refund', refundSig);
    check('SOL refund executed', rej.body?.data?.results?.[0]?.refund === 'refunded' && !!refundSig);
    // replay guard
    const replay = await post('/api/ads/confirm', { quoteId: 'nonexistent', signature: 'x' }, tok);
    check('bogus confirm rejected', replay.status >= 400);
  }

  const links = TXS.map((t) => ({ ...t, solscan: `https://solscan.io/tx/${t.sig}?cluster=${CLUSTER}` }));
  writeFileSync('/tmp/ad_devnet_txs.json', JSON.stringify({ cluster: CLUSTER, usdcMint: usdc.toBase58(), wocMint: woc.toBase58(), keeper: keeper.publicKey.toBase58(), buyer: buyer.publicKey.toBase58(), txs: links }, null, 2));
  console.log('\n=== Solscan links ===');
  for (const l of links) console.log(`${l.label.padEnd(20)} ${l.solscan}`);
  console.log(`\n${passes} passed, ${fails} failed`);
  await db.end();
  server.kill();
  process.exit(fails === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
