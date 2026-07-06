// Records the Claudium native-rail ($WOC) purchase working INSIDE the real running
// game world (the 3D world + HUD) on Solana devnet, paying in mock $WOC.
//
// This boots the actual game client (npm run dev, offline world), opens the real
// Claudium window through its own module (Hud.attachClaudium + Hud.toggleClaudium),
// picks the $WOC rail, shows the live service quote (amount, address, memo, split,
// countdown), runs the REAL on-chain payment legs (mint + buyer pay + burn/treasury
// split + confirm) via the funded keypair-driven devnet flow, then confirms the
// purchase, crediting Claudium in the window. A CDP screencast is stitched into an
// mp4 with ffmpeg so the video shows the game world with the window completing the
// purchase, backed by real devnet signatures.
//
// SEAM: the in-game wallet is signMessage-only (cannot sign transactions), so the
// PAY leg is driven out-of-band by the funded devnet keypair (the proven
// devnet_purchase.mjs flow), exactly as the service repo does. The window's
// nativeQuote / nativeConfirm deps are injected to return the REAL service quote and
// the REAL settled result from that on-chain flow; nothing is faked, the signatures
// are genuine devnet signatures.
//
// Modeled on scripts/claudium_shot.mjs (offline boot + real Claudium module) and the
// service repo's scripts/claudium_record.mjs (CDP screencast -> ffmpeg mp4 pattern).

import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import puppeteer from 'puppeteer-core';
import { runPurchase } from '/Users/futjr/woc/svc-daily-rewards/service/scripts/devnet_purchase.mjs';
import { BROWSER_PATH } from './browser_path.mjs';

const URL = process.env.GAME_URL ?? 'http://localhost:5173';
const OUT_DIR = 'docs/videos';
const OUT = `${OUT_DIR}/claudium_ingame_woc_devnet.mp4`;
const FRAMES = '/tmp/claudium_ingame_frames';
const FFMPEG = process.env.FFMPEG ?? '/opt/homebrew/bin/ffmpeg';
const FPS = 10;
const WOC_TOKEN_DECIMALS = 6;
// $10 -> 1000 Claudium, matching the amount ladder rung the window offers.
const CLAUDIUM_AMOUNT = Number(process.env.CLAUDIUM_AMOUNT ?? 1000);
process.env.CLAUDIUM_AMOUNT = String(CLAUDIUM_AMOUNT);

if (existsSync(FRAMES)) rmSync(FRAMES, { recursive: true });
mkdirSync(FRAMES, { recursive: true });
mkdirSync(OUT_DIR, { recursive: true });

// ---- Shared state the real on-chain flow fills; the browser deps read from it. ----
const purchase = {
  quote: null, // the real service quote (amountBase, destination, memo, split, expiry)
  paySig: null, // the real on-chain pay signature the window shows + confirms against
  mintSig: null,
  burnSig: null,
  treasurySig: null,
  credited: null, // the real credited Claudium balance from the settled confirm
  reason: null,
  done: false,
  error: null,
};

const sigs = [];
function onStep(s) {
  const short = (v) => (typeof v === 'string' ? v : JSON.stringify(v));
  console.log(`[chain] ${s.step}${s.signature ? ` sig=${short(s.signature)}` : ''}`);
  if (s.step === 'quote') {
    purchase.quote = {
      reference: s.reference,
      rail: 'woc',
      claudium: CLAUDIUM_AMOUNT,
      amountBase: s.amountBase,
      destination: s.destination,
      mint: 'E6r4tqSuQ6VuCa9jpPZMqYHAj1x9GJaKaaXWxrfFsgFx',
      memo: s.memo,
      quoteExpiryMs: s.quoteExpiryMs,
      split: { burnBase: s.burnBase, treasuryBase: s.treasuryBase, treasury: s.destination },
      reason: null,
    };
  }
  if (s.step === 'mint') purchase.mintSig = s.signature;
  if (s.step === 'burn') purchase.burnSig = s.signature;
  if (s.step === 'treasury') purchase.treasurySig = s.signature;
  if (s.step === 'pay') purchase.paySig = s.signature;
  if (s.step === 'confirm') {
    purchase.reason = s.reason ?? null;
    if (s.fulfillment && typeof s.fulfillment.balance === 'number') {
      purchase.credited = s.fulfillment.balance;
    }
  }
  if (s.step === 'done') {
    purchase.credited = s.claudiumCredited;
    purchase.done = true;
  }
  if (s.signature) sigs.push({ step: s.step, signature: s.signature });
  if (s.step === 'fatal' || s.step === 'split_error') {
    purchase.error = `${s.step}: ${s.reason ?? s.error}`;
  }
}

// Kick the real on-chain purchase off immediately; it runs to completion (quote ->
// mint -> pay -> split -> confirm) in this Node process while the browser displays
// the captured real values step by step.
const chainDone = runPurchase(onStep).catch((err) => {
  purchase.error = String(err);
  purchase.done = true;
});

const waitFor = async (pred, timeoutMs, label) => {
  const start = Date.now();
  while (!pred()) {
    if (purchase.error) throw new Error(`on-chain flow failed: ${purchase.error}`);
    if (Date.now() - start > timeoutMs) throw new Error(`timeout waiting for ${label}`);
    await new Promise((r) => setTimeout(r, 200));
  }
};

// ---- Boot the real game (offline world) and record it. ----
const browser = await puppeteer.launch({
  executablePath: BROWSER_PATH,
  headless: 'new',
  args: ['--window-size=1600,900', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
  defaultViewport: { width: 1600, height: 900 },
});
const page = await browser.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push('PAGEERROR: ' + e.message));
page.on('console', (m) => {
  if (m.type() === 'error') errors.push('CONSOLE: ' + m.text());
});

// Bridge the real service quote / confirm into the browser window deps.
await page.exposeFunction('__claudiumNativeQuote', async () => {
  await waitFor(() => purchase.quote !== null, 120000, 'service quote');
  return { ...purchase.quote, wocDecimals: WOC_TOKEN_DECIMALS };
});
await page.exposeFunction('__claudiumPaySignature', async () => {
  await waitFor(() => purchase.paySig !== null, 240000, 'on-chain pay signature');
  return purchase.paySig;
});
await page.exposeFunction('__claudiumBalance', () =>
  purchase.done && purchase.credited !== null ? purchase.credited : 0,
);
await page.exposeFunction('__claudiumNativeConfirm', async () => {
  await waitFor(() => purchase.done, 240000, 'settled confirm');
  if (purchase.credited === null) {
    return { credited: false, balance: null, denominationClaudium: null, reason: purchase.reason };
  }
  return {
    credited: true,
    balance: purchase.credited,
    denominationClaudium: null,
    reason: purchase.reason,
  };
});

await page.goto(URL, { waitUntil: 'networkidle0', timeout: 30000 });
// Boot the offline world through the aria-hidden compat trigger (no clickable point).
await page.evaluate(() => document.querySelector('#btn-offline').click());
await page.waitForSelector('#offline-select .mini-class[data-class="warrior"]', {
  visible: true,
  timeout: 30000,
});
await new Promise((r) => setTimeout(r, 200));
await page.type('#char-name', 'Claudia');
await page.click('#offline-select .mini-class[data-class="warrior"]');
await page.click('#btn-start-offline');

// Wait for the sim player + a visible HUD (the real game world is up).
await page.waitForFunction(
  () =>
    window.__game?.sim?.player &&
    getComputedStyle(document.querySelector('#ui')).display !== 'none',
  { timeout: 120000 },
);
await new Promise((r) => setTimeout(r, 1200));

// Attach the Claudium hooks that bridge to the REAL service/on-chain flow. The
// snapshot funds the window (balance + skus + the woc oracle price so the $WOC rail
// enables); nativeQuote / nativeConfirm resolve the genuine devnet quote + settlement.
await page.evaluate((claudiumAmount) => {
  window.__game.hud.attachClaudium({
    snapshot: async () => ({
      balance: await window.__claudiumBalance(),
      skus: [
        { sku: 's1', usd: 1, claudium: 100 },
        { sku: 's5', usd: 5, claudium: 500 },
        { sku: 's10', usd: 10, claudium: claudiumAmount },
        { sku: 's100', usd: 100, claudium: 10000 },
      ],
      // A present woc oracle price enables the $WOC rail in the picker.
      price: { usdPerClaudium: 0.01, wocBaseUnitsPerClaudium: 42 },
      storeItems: [
        { itemId: 'hat_gold', name: 'Gilded Circlet', kind: 'cosmetic', costClaudium: 500 },
        { itemId: 'skin_ember', name: 'Ember Warplate Skin', kind: 'skin', costClaudium: 2000 },
      ],
    }),
    buy: () => {},
    spend: () => {},
    nativeQuote: async () => window.__claudiumNativeQuote(),
    nativeConfirm: async () => window.__claudiumNativeConfirm(),
    redeem: async () => ({
      credited: false,
      balance: null,
      denominationClaudium: null,
      reason: 'unavailable',
    }),
  });
}, CLAUDIUM_AMOUNT);

// ---- Start the CDP screencast of the real game world. ----
const client = await page.target().createCDPSession();
let frame = 0;
client.on('Page.screencastFrame', async (f) => {
  writeFileSync(
    `${FRAMES}/f_${String(frame++).padStart(5, '0')}.jpg`,
    Buffer.from(f.data, 'base64'),
  );
  try {
    await client.send('Page.screencastFrameAck', { sessionId: f.sessionId });
  } catch {}
});
await client.send('Page.startScreencast', { format: 'jpeg', quality: 85, everyNthFrame: 1 });

// Open the Claudium window inside the running world.
await page.evaluate(() => window.__game.hud.toggleClaudium());
await new Promise((r) => setTimeout(r, 1200));

// Pick the $WOC native rail.
await page.evaluate(() => {
  document.querySelector('#claudium-window .cl-rail[data-rail="woc"]')?.click();
});
await new Promise((r) => setTimeout(r, 1000));

// Click the amount rung that quotes the target Claudium amount; this fires the
// injected nativeQuote, which resolves the REAL service quote and paints the pay
// panel (exact $WOC amount, destination, memo, burn/treasury split, live countdown).
await page.evaluate((claudiumAmount) => {
  const sel = `#claudium-window .cl-sku[data-quote-claudium="${claudiumAmount}"]`;
  document.querySelector(sel)?.click();
}, CLAUDIUM_AMOUNT);

// Wait for the pay panel to render with the real amount + address + memo.
await page.waitForFunction(
  () => {
    const w = document.querySelector('#claudium-window');
    return (
      w &&
      w.querySelector('.cl-pay-amount') &&
      w.querySelector('.cl-field-value') &&
      w.querySelector('.cl-countdown')
    );
  },
  { timeout: 120000 },
);
// Linger on the live quote (amount, address, memo, split, countdown).
await new Promise((r) => setTimeout(r, 3500));

// The real on-chain payment is running; wait for the genuine devnet pay signature,
// paste it into the window's signature field (the copy-and-confirm flow), and let
// the confirmation settle on-chain.
const paySig = await page.evaluate(() => window.__claudiumPaySignature());
await page.evaluate((sig) => {
  const input = document.querySelector('#claudium-window #cl-sig');
  if (input) {
    input.value = sig;
    input.dispatchEvent(new Event('input', { bubbles: true }));
  }
}, paySig);
await new Promise((r) => setTimeout(r, 1800));

// Click Confirm: the injected nativeConfirm resolves the REAL settled result and the
// window paints the credited Claudium balance.
await page.evaluate(() => {
  document.querySelector('#claudium-window [data-quote-confirm]')?.click();
});

// Wait for the credited state to paint in the window.
await page.waitForFunction(
  () => {
    const note = document.querySelector('#claudium-window .cl-pay .cl-rail-note');
    return note && note.textContent && note.textContent.trim().length > 0;
  },
  { timeout: 240000 },
);
await new Promise((r) => setTimeout(r, 3000)); // linger on the credited state

await client.send('Page.stopScreencast');

// Make sure the on-chain flow fully finished (all sigs collected).
await chainDone;
await new Promise((r) => setTimeout(r, 300));

const shotName = 'docs/screenshots/claudium/claudium_ingame_credited.png';
mkdirSync('docs/screenshots/claudium', { recursive: true });
await page.screenshot({ path: shotName });

await browser.close();

if (purchase.error) {
  console.error('on-chain flow error:', purchase.error);
}

const count = readdirSync(FRAMES).filter((f) => f.endsWith('.jpg')).length;
console.log(`captured ${count} frames`);
if (count === 0) {
  console.error('no frames captured');
  process.exit(1);
}

const ff = spawnSync(
  FFMPEG,
  [
    '-y',
    '-framerate',
    String(FPS),
    '-pattern_type',
    'glob',
    '-i',
    `${FRAMES}/f_*.jpg`,
    '-vf',
    'scale=1600:-2:flags=lanczos,format=yuv420p',
    '-movflags',
    '+faststart',
    OUT,
  ],
  { encoding: 'utf8' },
);
if (ff.status !== 0) {
  console.error(ff.stderr?.slice(-1200));
  process.exit(1);
}

console.log(`\nwrote ${OUT}`);
console.log('real devnet signatures:');
for (const s of sigs) console.log(`  ${s.step}: ${s.signature}`);
console.log(`credited Claudium: ${purchase.credited}`);
console.log(errors.length ? 'PAGE ERRORS:\n' + errors.join('\n') : 'no console/page errors');
