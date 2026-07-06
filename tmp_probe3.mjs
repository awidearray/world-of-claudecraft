import puppeteer from 'puppeteer-core';
import { BROWSER_PATH } from './scripts/browser_path.mjs';
const b = await puppeteer.launch({ executablePath: BROWSER_PATH, headless: 'new',
  args: ['--window-size=1100,900','--use-angle=swiftshader','--enable-unsafe-swiftshader'],
  defaultViewport: { width: 1100, height: 900 } });
const p = await b.newPage();
p.on('pageerror', (e) => console.log('PAGEERROR:', e.message));
await p.goto('http://localhost:5173', { waitUntil: 'domcontentloaded', timeout: 30000 });
await p.waitForSelector('#btn-offline', { timeout: 15000 });
await p.evaluate(() => document.querySelector('#btn-offline').click());
await new Promise(r => setTimeout(r, 300));
await p.type('#char-name', 'Helper');
await p.evaluate(() => document.querySelector('#offline-select .mini-class[data-class="warrior"]').click());
await p.evaluate(() => document.querySelector('#btn-start-offline').click());
await p.waitForFunction(() => window.__game?.sim?.player && getComputedStyle(document.querySelector('#ui')).display !== 'none', { timeout: 120000 });
await new Promise(r => setTimeout(r, 600));
const st = await p.evaluate(() => {
  const el = document.querySelector('#bags');
  el.style.display = 'none';
  window.__game.hud.toggleBags();
  return new Promise(res => setTimeout(() => {
    const chip = document.querySelector('#bags [data-wallet]');
    res({ chip: !!chip, bagsHtmlHead: document.querySelector('#bags')?.innerHTML.slice(0,400),
      walletish: [...document.querySelectorAll('#bags *')].filter(e => (e.className+' '+(e.id||'')).match(/wallet|woc|balance/i)).map(e => e.tagName+'.'+e.className).slice(0,8) });
  }, 400));
});
console.log(JSON.stringify(st, null, 1));
await b.close();
