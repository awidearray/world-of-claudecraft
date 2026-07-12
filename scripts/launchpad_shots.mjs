// Standalone screenshot harness for the realm token launchpad panel (phases
// 0 to 8), the public Levy Street Fund page (phase 6), and the HUD money
// re-skin (phase 7). It does NOT drive the live app: a rendered launchpad
// needs a provisioned realm, a registered token, verified on-chain locks, and
// a live curve, none of which exist locally. So instead we esbuild-bundle the
// REAL src/ui/realm_launchpad.ts and src/ui/levy_fund.ts components, mount
// them with STUBBED hosts returning realistic pinned data, drive the REAL
// Hud.prototype.moneyHtml for the currency re-skin strip, inline the real
// tokens/base/shell CSS, and puppeteer-screenshot each panel at desktop and
// mobile widths. Faithful (real components + real CSS) and deterministic.
//
// Pattern: scripts/realm_buy_shot.mjs (stub-host harness) +
// account_portal_shots.mjs (puppeteer-core). Outputs PNGs into
// docs/screenshots/. Build artifacts go under tmp/ (gitignored).
// Run: node scripts/launchpad_shots.mjs

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import * as esbuild from 'esbuild';
import puppeteer from 'puppeteer-core';
import { BROWSER_PATH } from './browser_path.mjs';

const root = process.cwd();
const tmpDir = path.join(root, 'tmp');
const outDir = path.join(root, 'docs', 'screenshots');
mkdirSync(tmpDir, { recursive: true });
mkdirSync(outDir, { recursive: true });

// ---------------------------------------------------------------------------
// 1) The real stylesheet chain the shell panels use: tokens (vars), base
//    (reset + fonts), shell (.panel/.auth-panel/.ro-*/.lp-*/.lf-*). The files
//    declare @layer tiers whose order src/styles/index.css pins; replicate
//    that order statement so the cascade matches the app.
// ---------------------------------------------------------------------------
const cssFiles = ['tokens.css', 'base.css', 'shell.css'];
const layerOrder = readFileSync(path.join(root, 'src/styles/index.css'), 'utf8')
  .split('\n')
  .find((l) => l.startsWith('@layer '));
const css = [
  layerOrder ?? '',
  ...cssFiles.map((f) => readFileSync(path.join(root, 'src/styles', f), 'utf8')),
].join('\n');

// ---------------------------------------------------------------------------
// 2) The harness entry: mount the REAL RealmLaunchpad (a live POWER realm at
//    the richest state: verified locks, live curve mid-migration, the
//    token-to-copper convert section) and the REAL LevyFundPanel (a published
//    three-holding portfolio), plus a before/after strip of the REAL
//    Hud.prototype.moneyHtml (classic coins vs the realm-token re-skin).
//    Every value is pinned (no Date.now / Math.random) so shots reproduce.
// ---------------------------------------------------------------------------
const launch = {
  prepared: true,
  mint: 'Fm9oQ7VbT2yLxW4cJ8dK1pR6sN3aG5uHhE2iZbXnMoon',
  pendingMint: null,
  supplyBase: '1000000000000000000',
  alloc: {
    publicBps: 6000,
    liquidityBps: 1000,
    founderBps: 1200,
    levyBps: 800,
    treasuryBps: 1000,
  },
  split: {
    publicBase: '600000000000000000',
    liquidityBase: '100000000000000000',
    founderBase: '120000000000000000',
    levyBase: '80000000000000000',
    treasuryBase: '100000000000000000',
  },
  lockTerms: [
    {
      bucket: 'founder',
      recipient: '7nQ2bF9rK4mXp1wZ8sVcD6tLgYhE3aJ5uN0RqWoP2dM',
      amountBase: '120000000000000000',
      cliffMonths: 12,
      linearMonths: 36,
      frequencySeconds: '2629746',
      cliffUnlockAmount: '0',
      amountPerPeriod: '3333333333333333',
      numberOfPeriod: '36',
    },
    {
      bucket: 'levy',
      recipient: '5Q544fKrFoe6tsEbD7S8EmxGTJYAKtTVhAW5Q5pge4j',
      amountBase: '80000000000000000',
      cliffMonths: 12,
      linearMonths: 48,
      frequencySeconds: '2629746',
      cliffUnlockAmount: '0',
      amountPerPeriod: '1666666666666666',
      numberOfPeriod: '48',
    },
    {
      bucket: 'treasury',
      recipient: '8xj1k9Qn3pVeRc2mYtHbWqLZ4dFgN7sUvT6rA1oP3eX',
      amountBase: '100000000000000000',
      cliffMonths: 6,
      linearMonths: 24,
      frequencySeconds: '2629746',
      cliffUnlockAmount: '0',
      amountPerPeriod: '4166666666666666',
      numberOfPeriod: '24',
    },
  ],
  lockAddresses: {
    founder: 'CTf3Yhz3iCPvVXcQEMDP7BfEqjVdCEJ3D34AbnFXBUby',
    levy: '9m3f6qYJ99UTk5RQyLyr1AYPcTDo7NGxZfsLJyAAWgEu',
    treasury: 'FjK2mQ7vN4xW8yT1pRbL6sD9aG3uH5cJeZ0iXnMo4PqS',
  },
  mintConfirmed: true,
  locksVerified: true,
};

const page = {
  token: {
    realmId: 7,
    symbol: 'MOON',
    icon: 'moon_coin',
    status: 'live',
    monetizationPolicy: 'power',
    mint: launch.mint,
    decimals: 9,
  },
  vote: null,
  presale: null,
  isOwner: true,
};

const curve = {
  host: 'meteora-dbc',
  config: {
    quoteMint: '',
    migrationQuoteThresholdBase: '450000000000',
    partnerLockedLpBps: 5000,
    creatorLockedLpBps: 5000,
  },
  curve: {
    poolAddress: 'CuRv3P8mW1qYtL6kD4xJ9rB2vF7sN5aG3uHeZ1iXbPoQ',
    quoteReserveBase: '328500000000',
    progressBps: 7300,
    migrated: false,
  },
  graduated: false,
};

const fund = {
  aumUsd: 1284650.37,
  aumClamped: false,
  solUsd: 151.24,
  updatedAt: '2026-07-11T17:20:00.000Z',
  holdings: [
    {
      mint: launch.mint,
      symbol: 'MOON',
      amountBase: '80000000000000000',
      decimals: 9,
      weightBps: 6100,
      priceUsd: 0.0098,
      valueUsd: 784000.0,
      locked: true,
      graduated: false,
      source: 'curve',
      confidence: 'high',
      illiquid: false,
    },
    {
      mint: 'GLmR7wPqX2yK9tB4sN1aJ6cD8uF3vH5eZiWbTo2QnMxA',
      symbol: 'GLIM',
      amountBase: '64000000000000000',
      decimals: 9,
      weightBps: 3800,
      priceUsd: 0.0078,
      valueUsd: 499200.0,
      locked: true,
      graduated: true,
      source: 'jupiter',
      confidence: 'medium',
      illiquid: false,
    },
    {
      mint: 'DrKn4tQ8vL1xW6yP3sR9aB2uG7cJ5eNfZ0iXhMo8TqYd',
      symbol: 'DRKN',
      amountBase: '52000000000000000',
      decimals: 9,
      weightBps: 0,
      priceUsd: null,
      valueUsd: null,
      locked: true,
      graduated: false,
      source: 'none',
      confidence: 'low',
      illiquid: true,
    },
  ],
};

const realEntry = `
import { RealmLaunchpad } from '../src/ui/realm_launchpad';
import { LevyFundPanel } from '../src/ui/levy_fund';
import { Hud } from '../src/ui/hud';
import { setLanguage } from '../src/ui/i18n';

setLanguage('en');

const LAUNCH = ${JSON.stringify(launch)};
const PAGE = ${JSON.stringify(page)};
const CURVE = ${JSON.stringify(curve)};
const FUND = ${JSON.stringify(fund)};

const launchpadHost = {
  api: {
    realmToken: async () => PAGE,
    realmLaunch: async () => LAUNCH,
    realmCurve: async () => CURVE,
    characters: async () => [
      { id: 31, name: 'Thornveil', class: 'druid', level: 20, skin: 0 },
      { id: 32, name: 'Emberlash', class: 'mage', level: 14, skin: 1 },
    ],
  },
  realm: { realmId: 7, name: 'Moonrealm' },
  linkedWallet: () => '7nQ2bF9rK4mXp1wZ8sVcD6tLgYhE3aJ5uN0RqWoP2dM',
  ensureWalletReady: async () => '7nQ2bF9rK4mXp1wZ8sVcD6tLgYhE3aJ5uN0RqWoP2dM',
  signContribution: async () => null,
  signServerTransaction: async () => null,
  signPowerCredit: async () => null,
  close: () => {},
};

const fundHost = {
  api: { levyFund: async () => ({ fund: FUND, policy: {} }) },
  close: () => {},
};

// The HUD money readout, driven through the REAL Hud.prototype.moneyHtml with
// a minimal IWorld carrying only realmCurrency() (the sole instance read that
// method makes). Before: the classic gold/silver/copper coins. After: the
// same opaque copper re-skinned into the realm token identity.
function moneyStrip(): void {
  const before = Hud.prototype.moneyHtml.call({ sim: { realmCurrency: () => null } }, 1234567);
  const after = Hud.prototype.moneyHtml.call(
    { sim: { realmCurrency: () => ({ symbol: 'MOON', icon: 'moon_coin' }) } },
    1234567,
  );
  const el = document.getElementById('money-strip');
  if (!el) return;
  el.innerHTML =
    '<div class="ms-row"><span class="ms-label">Classic realm (no token)</span>' + before + '</div>' +
    '<div class="ms-row"><span class="ms-label">Tokenized realm (phase 7 re-skin)</span>' + after + '</div>';
}

(async () => {
  const lp = new RealmLaunchpad(document.getElementById('launchpad-body') as HTMLElement, launchpadHost as never);
  const lf = new LevyFundPanel(document.getElementById('fund-body') as HTMLElement, fundHost as never);
  await lp.open();
  await lf.open();
  moneyStrip();
  await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
  (window as never as { __shot: { ready: boolean } }).__shot = { ready: true };
})();
`;

const entryPath = path.join(tmpDir, 'launchpad_shots_entry.ts');
writeFileSync(entryPath, realEntry);

const build = await esbuild.build({
  entryPoints: [entryPath],
  bundle: true,
  platform: 'browser',
  format: 'iife',
  write: false,
  logLevel: 'silent',
  absWorkingDir: root,
  loader: { '.ts': 'ts' },
  define: {
    'import.meta.env.PROD': 'false',
    'import.meta.env.DEV': 'true',
    'import.meta.env.MODE': '"development"',
    'import.meta.env': '{"PROD":false,"DEV":true,"MODE":"development"}',
  },
});
const bundledJs = build.outputFiles[0].text;

// ---------------------------------------------------------------------------
// 3) Harness HTML: the app's panel chrome around each mounted component, plus
//    a small strip style for the money before/after (harness-only chrome).
// ---------------------------------------------------------------------------
const harnessHtml = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<style>
${css}
</style>
<style>
  html, body {
    margin: 0; padding: 0;
    background: radial-gradient(120% 120% at 50% 0%, #161320 0%, #0a0a10 60%, #060609 100%);
    min-height: 100vh; color: #f0ead8; font-family: var(--font-ui, system-ui, sans-serif);
  }
  .harness-wrap { display: flex; flex-direction: column; align-items: center; gap: 36px; padding: 28px 16px 48px; }
  .harness-wrap .panel { margin: 0; width: min(560px, 94vw); max-width: none; height: auto; min-height: 0; }
  #fund-panel { width: min(760px, 94vw); }
  .harness-wrap .ro { max-height: none; overflow: visible; }
  /* Money strip: the bags-footer context the readout lives in. */
  #money-strip { display: flex; flex-direction: column; gap: 14px; padding: 18px 22px;
    border: 1px solid #322c1d; border-radius: 8px; background: #14110a; width: min(460px, 94vw); box-sizing: border-box; }
  .ms-row { display: flex; align-items: center; justify-content: space-between; gap: 18px; font-size: 13px; }
  .ms-label { color: #998d6a; font-size: 11px; }
  .money-inline { display: inline-flex; gap: 8px; align-items: center; }
  .coin-part { display: inline-flex; gap: 3px; align-items: center; color: #e7dcb4; }
  .coin { width: 12px; height: 12px; border-radius: 50%; display: inline-block; }
  .coin.g { background: radial-gradient(circle at 35% 30%, #ffe9a3, #c9a13b 70%); }
  .coin.s { background: radial-gradient(circle at 35% 30%, #f2f2f2, #9aa0ad 70%); }
  .coin.c { background: radial-gradient(circle at 35% 30%, #e8a877, #9a5b2e 70%); }
  .coin-realm { width: 16px; height: 16px; border-radius: 3px; }
  .coin-symbol { color: #f2d98a; font-weight: 600; }
</style>
</head>
<body>
<div class="harness-wrap">
  <div id="launchpad-panel" class="panel auth-panel auth-panel-premium">
    <div id="launchpad-body"></div>
  </div>
  <div id="fund-panel" class="panel auth-panel auth-panel-premium">
    <div id="fund-body"></div>
  </div>
  <div id="money-strip"></div>
</div>
<script>
${bundledJs}
</script>
</body>
</html>`;

const harnessPath = path.join(tmpDir, 'launchpad_shots.html');
writeFileSync(harnessPath, harnessHtml);

// ---------------------------------------------------------------------------
// 4) Puppeteer: capture each panel element at desktop, then the launchpad and
//    fund again at a mobile-portrait viewport.
// ---------------------------------------------------------------------------
const browser = await puppeteer.launch({
  executablePath: BROWSER_PATH,
  headless: 'new',
  args: ['--no-sandbox', '--window-size=1440,1200'],
});

try {
  const pageHandle = await browser.newPage();
  const pageErrors = [];
  pageHandle.on('pageerror', (err) => pageErrors.push(String(err)));
  await pageHandle.setViewport({ width: 1440, height: 1200, deviceScaleFactor: 2 });
  await pageHandle.goto(`file://${harnessPath}`);
  await pageHandle.waitForFunction('window.__shot && window.__shot.ready', { timeout: 20000 });

  // An element taller than the viewport paints blank past the fold in headless
  // element captures, so size the viewport to the element before each shot.
  const shoot = async (width, selector, file) => {
    const height = await pageHandle.evaluate((sel) => {
      const el = document.querySelector(sel);
      return el ? Math.ceil(el.getBoundingClientRect().height) + 80 : 0;
    }, selector);
    if (height === 0) throw new Error(`missing ${selector}`);
    await pageHandle.setViewport({ width, height, deviceScaleFactor: 2 });
    const el = await pageHandle.$(selector);
    await el.screenshot({ path: path.join(outDir, file) });
    console.log(`wrote docs/screenshots/${file}`);
  };

  await shoot(1440, '#launchpad-panel', 'launchpad-live-power.png');
  await shoot(1440, '#fund-panel', 'levy-street-fund.png');
  await shoot(1440, '#money-strip', 'hud-money-reskin.png');

  await pageHandle.setViewport({ width: 390, height: 1400, deviceScaleFactor: 2 });
  await pageHandle.goto(`file://${harnessPath}`);
  await pageHandle.waitForFunction('window.__shot && window.__shot.ready', { timeout: 20000 });
  await shoot(390, '#launchpad-panel', 'launchpad-live-power-mobile.png');
  await shoot(390, '#fund-panel', 'levy-street-fund-mobile.png');

  if (pageErrors.length > 0) {
    throw new Error(`page errors:\n${pageErrors.join('\n')}`);
  }
} finally {
  await browser.close();
}
