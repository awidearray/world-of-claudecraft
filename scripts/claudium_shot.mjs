// Screenshots for the Claudium store window, the design-sweep before/after
// evidence. Captures the funded window across BOTH a dark theme (Midnight) and a
// light theme (Parchment), and across the key states the sweep touched:
//   - buy tab with a native WOC pay panel: the review line, the split summary, the
//     countdown, and the large copyable pay address (D3/D5)
//   - the calm pending/confirming state after Confirm (D6)
//   - the redeem tab
//   - the cosmetic store with a top-up prompt on an unaffordable item (D7)
// Every Claudium amount shows its USD equivalent (D2), styles are tokenized so the
// window reads in both themes (D1/D8).
//
// It also keeps the graceful-degradation proof: with NO economy service the window
// opens through its real module and renders the clean disabled state.
//
// Modeled on scripts/clock_shot.mjs (offline boot). The theme is set by writing the
// woc_theme localStorage key before load (ThemeStore reads it on boot).
import fs from 'node:fs';
import puppeteer from 'puppeteer-core';
import { BROWSER_PATH as EDGE } from './browser_path.mjs';

const URL = process.env.GAME_URL ?? 'http://localhost:5173';
const OUT = 'docs/screenshots/claudium';
fs.mkdirSync(OUT, { recursive: true });

const browser = await puppeteer.launch({
  executablePath: EDGE,
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

// The funded deps: a balance + SKU ladder + store items (one deliberately priced
// above the balance to trigger the D7 top-up prompt), plus native quote/confirm.
const FUNDED_DEPS = `{
  snapshot: async () => ({
    balance: 1250,
    skus: [
      { sku: 's1', usd: 1, claudium: 100 },
      { sku: 's5', usd: 5, claudium: 500 },
      { sku: 's10', usd: 10, claudium: 1000 },
      { sku: 's100', usd: 100, claudium: 10000 },
    ],
    price: { usdPerClaudium: 0.01, wocBaseUnitsPerClaudium: 42 },
    storeItems: [
      { itemId: 'hat_gold', name: 'Gilded Circlet', kind: 'cosmetic', costClaudium: 500 },
      { itemId: 'skin_ember', name: 'Ember Warplate Skin', kind: 'skin', costClaudium: 2000 },
      { itemId: 'trail_frost', name: 'Frostfall Trail', kind: 'item', costClaudium: 750 },
    ],
  }),
  buy: () => {},
  spend: () => {},
  nativeQuote: async (rail, claudium) => ({
    reference: 'ref-woc-demo',
    rail,
    claudium,
    amountBase: '5000000',
    destination: 'WoCTreasuryAddr1111111111111111111111111111',
    mint: 'WoCmint1111111111111111111111111111111111111',
    memo: 'CLDM:ref-woc-demo',
    quoteExpiryMs: Date.now() + 9 * 60 * 1000,
    wocDecimals: 6,
    split: {
      burnBase: '2500000',
      treasuryBase: '2500000',
      treasury: 'WoCTreasuryAddr1111111111111111111111111111',
    },
    reason: null,
  }),
  nativeConfirm: () => new Promise(() => {}),
  redeem: async () => ({ credited: false, balance: null, denominationClaudium: null, reason: 'unavailable' }),
}`;

const shoot = async (name) => {
  await new Promise((r) => setTimeout(r, 450));
  await page.screenshot({ path: `${OUT}/${name}.png` });
};

async function bootWithTheme(preset) {
  // Set the theme preset before boot; ThemeStore reads woc_theme on construction.
  await page.evaluateOnNewDocument((p) => {
    localStorage.setItem('woc_theme', JSON.stringify({ preset: p, custom: {} }));
  }, preset);
  await page.goto(URL, { waitUntil: 'networkidle0', timeout: 30000 });
  await page.evaluate(() => document.querySelector('#btn-offline').click());
  await page.waitForSelector('#offline-select .mini-class[data-class="warrior"]', {
    visible: true,
    timeout: 30000,
  });
  await new Promise((r) => setTimeout(r, 200));
  await page.type('#char-name', 'Thorgar');
  await page.click('#offline-select .mini-class[data-class="warrior"]');
  await page.click('#btn-start-offline');
  await page.waitForFunction(
    () =>
      window.__game?.sim?.player &&
      getComputedStyle(document.querySelector('#ui')).display !== 'none',
    { timeout: 120000 },
  );
  await new Promise((r) => setTimeout(r, 800));
}

async function captureTheme(theme) {
  await bootWithTheme(theme);

  // Disabled/service-off state (only needs one theme; dark is representative).
  if (theme === 'midnight') {
    await page.evaluate(() => window.__game.hud.toggleClaudium());
    await shoot('claudium_service_off');
    await page.evaluate(() => window.__game.hud.toggleClaudium());
    await new Promise((r) => setTimeout(r, 150));
  }

  // Attach funded deps and open the window (buy tab, stripe rail by default).
  await page.evaluate((depsSrc) => {
    // eslint-disable-next-line no-eval
    const deps = eval('(' + depsSrc + ')');
    window.__game.hud.attachClaudium(deps);
    window.__game.hud.toggleClaudium();
  }, FUNDED_DEPS);
  await shoot(`claudium_buy_${theme}`);

  // Switch to the WOC native rail and request a quote to reach the pay panel.
  await page.evaluate(() => {
    const root = document.querySelector('#claudium-window');
    root.querySelector('[data-rail="woc"]')?.click();
  });
  await new Promise((r) => setTimeout(r, 200));
  await page.evaluate(() => {
    const root = document.querySelector('#claudium-window');
    root.querySelector('[data-quote-claudium]')?.click();
  });
  await new Promise((r) => setTimeout(r, 300));
  await shoot(`claudium_pay_panel_${theme}`);

  // Paste a signature and confirm to reach the calm pending state (the confirm
  // promise never resolves, so the pending state stays on screen).
  await page.evaluate(() => {
    const root = document.querySelector('#claudium-window');
    const sig = root.querySelector('#cl-sig');
    sig.value = '5rXw...demoSignature...9kQ2';
    root.querySelector('[data-quote-confirm]')?.click();
  });
  await new Promise((r) => setTimeout(r, 300));
  // Scroll the pending line + confirm actions into view (the body scrolls).
  await page.evaluate(() => {
    document.querySelector('#claudium-window .cl-pending')?.scrollIntoView({ block: 'center' });
  });
  await new Promise((r) => setTimeout(r, 200));
  await shoot(`claudium_pending_${theme}`);

  // Back to the amount step, then the redeem tab.
  await page.evaluate(() => {
    const root = document.querySelector('#claudium-window');
    root.querySelector('[data-quote-cancel]')?.click();
  });
  await new Promise((r) => setTimeout(r, 150));
  await page.evaluate(() => {
    document.querySelector('#claudium-window [data-tab="redeem"]')?.click();
  });
  await new Promise((r) => setTimeout(r, 150));
  await shoot(`claudium_redeem_${theme}`);

  // Back to buy, scroll to the store, capture the top-up prompt (the 2000-cost
  // item is above the 1250 balance, so it shows "Not enough Claudium / Top up").
  await page.evaluate(() => {
    document.querySelector('#claudium-window [data-tab="buy"]')?.click();
  });
  await new Promise((r) => setTimeout(r, 150));
  await page.evaluate(() => {
    const items = document.querySelectorAll('#claudium-window .cl-item');
    items[items.length - 1]?.scrollIntoView({ block: 'center' });
  });
  await shoot(`claudium_store_topup_${theme}`);

  await page.evaluate(() => window.__game.hud.toggleClaudium());
}

await captureTheme('midnight');
await captureTheme('parchment');

console.log(errors.length ? 'ERRORS:\n' + errors.join('\n') : 'no console/page errors');
await browser.close();
