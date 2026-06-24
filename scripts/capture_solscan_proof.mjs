// Capture Solscan transaction screenshots for the on-chain proof. Reads the tx
// list emitted by ad_devnet_shakeout.mjs (/tmp/ad_devnet_txs.json) and writes one
// PNG per transaction into docs/ad-marketplace-devnet-proof/ for the PR.
//
//   node scripts/capture_solscan_proof.mjs
import puppeteer from 'puppeteer-core';
import { readFileSync, mkdirSync } from 'node:fs';

const CHROME = process.env.CHROME_PATH ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const OUT = 'docs/ad-marketplace-devnet-proof';
const data = JSON.parse(readFileSync('/tmp/ad_devnet_txs.json', 'utf8'));
mkdirSync(OUT, { recursive: true });

const slug = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-');
// Solscan's data API blocks automated browsers (fresh profiles, headless or not).
// Capture from the official Solana Explorer instead — no anti-bot, renders
// headless — for the committed images. The Solscan LINKS remain the canonical
// reference in the proof doc + PR.
const explorerUrl = (sig) => `https://explorer.solana.com/tx/${sig}?cluster=devnet`;
const browser = await puppeteer.launch({
  headless: true,
  executablePath: CHROME,
  args: ['--no-sandbox', '--disable-dev-shm-usage', '--window-size=1456,1100'],
});
try {
  const page = await browser.newPage();
  await page.setViewport({ width: 1456, height: 950, deviceScaleFactor: 1 });
  await page.setUserAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36');
  let i = 0;
  for (const tx of data.txs) {
    i++;
    const file = `${OUT}/${i}-${slug(tx.label)}.png`;
    await page.goto(explorerUrl(tx.sig), { waitUntil: 'domcontentloaded', timeout: 60000 });
    // Wait for the Explorer overview to populate (finalized status + result).
    await page.waitForFunction(() => /Finalized|Confirmed/.test(document.body.innerText) && /Success|Result/.test(document.body.innerText), { timeout: 45000 }).catch(() => {});
    await new Promise((r) => setTimeout(r, 3000));
    await page.screenshot({ path: file, clip: { x: 0, y: 0, width: 1456, height: 1000 } });
    console.log(`captured ${tx.label} -> ${file}`);
  }
} finally {
  await browser.close();
}
console.log('done');
