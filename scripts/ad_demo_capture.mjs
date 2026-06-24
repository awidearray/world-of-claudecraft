// Demo + screenshot the ad creator (the buyer "place an ad" panel). Drives the
// real panel served by Vite, authenticates with a genuine advertiser token
// (challenge → sign → auth, the same flow the wallet does, minus the Reown UI),
// fills the form, and writes screenshots to docs/ad-marketplace-demo/.
//
//   APP=http://localhost:5180 SERVER=http://127.0.0.1:8787 node scripts/ad_demo_capture.mjs
import puppeteer from 'puppeteer-core';
import { ed25519 } from '@noble/curves/ed25519';
import { Keypair } from '@solana/web3.js';
import bs58 from 'bs58';
import { mkdirSync } from 'node:fs';

const CHROME = process.env.CHROME_PATH ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const APP = process.env.APP ?? 'http://localhost:5180';
const SERVER = process.env.SERVER ?? 'http://127.0.0.1:8787';
const OUT = 'docs/ad-marketplace-demo';
mkdirSync(OUT, { recursive: true });

// Real advertiser session: challenge → ed25519 sign → auth → bearer token.
const buyer = Keypair.generate();
const pubkey = buyer.publicKey.toBase58();
const post = (p, b) => fetch(SERVER + p, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b) }).then((r) => r.json());
const ch = await post('/api/ads/advertiser/challenge', { pubkey });
const sig = bs58.encode(ed25519.sign(new TextEncoder().encode(ch.message), buyer.secretKey.slice(0, 32)));
const auth = await post('/api/ads/advertiser/auth', { pubkey, signature: sig, nonce: ch.nonce });
console.log('advertiser token issued for', pubkey, '→ id', auth.advertiserId);

const browser = await puppeteer.launch({ headless: true, executablePath: CHROME, args: ['--no-sandbox', '--disable-dev-shm-usage'] });
try {
  const page = await browser.newPage();
  await page.setViewport({ width: 760, height: 1000, deviceScaleFactor: 2 });

  // 1. Initial panel — connect prompt.
  await page.goto(`${APP}/?advertise=1`, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForSelector('#ad-buy-window.visible .adb-connect', { timeout: 30000 });
  await new Promise((r) => setTimeout(r, 800));
  await page.screenshot({ path: `${OUT}/1-connect.png` });
  console.log('captured 1-connect');

  // Inject the real token + re-render the authed panel.
  await page.evaluate(async (tok, id, pk) => {
    const a = window.__adsApi;
    a.token = tok; a.advertiserId = id; a.pubkey = pk;
    await window.__adBuyPanel.open();
  }, auth.token, auth.advertiserId, pubkey);
  await page.waitForSelector('#adb-placement', { timeout: 15000 });
  await page.waitForFunction(() => document.querySelectorAll('#adb-placement option').length > 0, { timeout: 15000 });

  // 2. Fill a text/ticker ad paid in $WOC — shows the live price.
  await page.select('#adb-placement', 'ticker');
  await page.select('#adb-asset', 'WOC');
  await page.$eval('#adb-day', (el) => { el.value = '2026-06-28'; });
  await page.$eval('#adb-start', (el) => { el.value = '18:00'; });
  await page.$eval('#adb-minutes', (el) => { el.value = '30'; el.dispatchEvent(new Event('input', { bubbles: true })); });
  await page.waitForSelector('#adb-text', { timeout: 8000 });
  await page.$eval('#adb-text', (el) => { el.value = 'Acme Forge — finest blades in the realm. Visit the Town Square smithy.'; });
  await page.$eval('#adb-cta', (el) => { el.value = 'Get the App'; });
  await page.$eval('#adb-url', (el) => { el.value = 'https://example.com/acme'; });
  await new Promise((r) => setTimeout(r, 600));
  await page.screenshot({ path: `${OUT}/2-form-ticker-woc.png` });
  console.log('captured 2-form-ticker-woc');

  // 3. Switch to the newspaper front-page image slot paid in USDC — image upload + new price.
  await page.select('#adb-placement', 'newspaper-featured');
  await page.select('#adb-asset', 'USDC');
  await page.$eval('#adb-minutes', (el) => { el.value = '60'; el.dispatchEvent(new Event('input', { bubbles: true })); });
  await page.waitForSelector('#adb-img', { timeout: 8000 });
  await new Promise((r) => setTimeout(r, 600));
  await page.screenshot({ path: `${OUT}/3-form-newspaper-usdc.png` });
  console.log('captured 3-form-newspaper-usdc');
} finally {
  await browser.close();
}
console.log('done');
