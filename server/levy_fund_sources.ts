// Production price sources for the Levy Street Fund valuation (launchpad phase
// 6). The real Jupiter Price v3 / Birdeye / DEX Screener / Pyth fetches plus the
// venue-backed DBC curve mark, behind the pure `PriceSources` seam so the
// valuation logic stays unit-tested with fixtures. Every fetch fails SOFT to a
// null / illiquid mark (the valuation excludes, never zeroes), so an API outage
// degrades the dashboard, never crashes the keeper.

import type { LaunchVenue } from './realm_launchpad';
import type {
  CrossCheckPrice,
  CurveMark,
  JupiterPrice,
  PriceSources,
  PythSolUsd,
} from './token_valuation';

const JUPITER_PRICE_V3 = (
  process.env.JUPITER_PRICE_API ?? 'https://lite-api.jup.ag/price/v3'
).trim();
const BIRDEYE_API = (process.env.BIRDEYE_API ?? 'https://public-api.birdeye.so').trim();
const BIRDEYE_KEY = (process.env.BIRDEYE_API_KEY ?? '').trim();
const DEX_SCREENER_API = (process.env.DEX_SCREENER_API ?? 'https://api.dexscreener.com').trim();
const PYTH_HERMES = (process.env.PYTH_HERMES_API ?? 'https://hermes.pyth.network').trim();
// The Pyth SOL/USD price feed id (mainnet).
const PYTH_SOL_USD_FEED = (
  process.env.PYTH_SOL_USD_FEED ??
  'ef0d8b6fda2ceba41da15d4095d1da392a0d2f8ed0c6c7bc0f4cfac8c280b56d'
).trim();
const WSOL_MINT = 'So11111111111111111111111111111111111111112';

async function getJson(url: string, headers?: Record<string, string>): Promise<unknown | null> {
  try {
    const res = await fetch(url, { headers, signal: AbortSignal.timeout(8000) });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

// Jupiter Price v3, batched 50 mints per call (the API's cap). Prices are USD
// per whole token; a null / missing mint is left out of the map.
async function jupiterPrices(mints: string[]): Promise<Map<string, JupiterPrice>> {
  const out = new Map<string, JupiterPrice>();
  for (let i = 0; i < mints.length; i += 50) {
    const batch = mints.slice(i, i + 50);
    const data = (await getJson(`${JUPITER_PRICE_V3}?ids=${batch.join(',')}`)) as Record<
      string,
      { usdPrice?: number; price?: number } | null
    > | null;
    if (!data) continue;
    for (const mint of batch) {
      const entry = data[mint];
      const price = entry?.usdPrice ?? entry?.price;
      if (typeof price === 'number' && Number.isFinite(price) && price > 0) {
        out.set(mint, { mint, priceUsd: price });
      }
    }
  }
  return out;
}

async function birdeyePrice(mint: string): Promise<CrossCheckPrice> {
  if (!BIRDEYE_KEY) return { priceUsd: null, liquidityUsd: null };
  const data = (await getJson(`${BIRDEYE_API}/defi/price?address=${mint}`, {
    'X-API-KEY': BIRDEYE_KEY,
    'x-chain': 'solana',
  })) as { data?: { value?: number; liquidity?: number } } | null;
  const value = data?.data?.value;
  return {
    priceUsd: typeof value === 'number' && value > 0 ? value : null,
    liquidityUsd: typeof data?.data?.liquidity === 'number' ? data.data.liquidity : null,
  };
}

async function dexScreenerPrice(mint: string): Promise<CrossCheckPrice> {
  const data = (await getJson(`${DEX_SCREENER_API}/latest/dex/tokens/${mint}`)) as {
    pairs?: Array<{ priceUsd?: string; liquidity?: { usd?: number } }>;
  } | null;
  const pairs = data?.pairs ?? [];
  if (pairs.length === 0) return { priceUsd: null, liquidityUsd: null };
  // The deepest pool is the most trustworthy cross-check.
  const deepest = pairs.reduce((best, p) =>
    (p.liquidity?.usd ?? 0) > (best.liquidity?.usd ?? 0) ? p : best,
  );
  const price = Number.parseFloat(deepest.priceUsd ?? '');
  return {
    priceUsd: Number.isFinite(price) && price > 0 ? price : null,
    liquidityUsd: typeof deepest.liquidity?.usd === 'number' ? deepest.liquidity.usd : null,
  };
}

// Pyth Hermes latest price for SOL/USD, with the confidence band. Pyth prices
// carry an exponent; value = price x 10^expo.
async function pythSolUsd(): Promise<PythSolUsd> {
  const data = (await getJson(
    `${PYTH_HERMES}/v2/updates/price/latest?ids[]=${PYTH_SOL_USD_FEED}`,
  )) as {
    parsed?: Array<{
      price?: { price?: string; conf?: string; expo?: number; publish_time?: number };
    }>;
  } | null;
  const p = data?.parsed?.[0]?.price;
  if (!p || typeof p.price !== 'string' || typeof p.expo !== 'number') {
    return { priceUsd: 0, confIntervalUsd: 0, stale: true };
  }
  const scale = 10 ** p.expo;
  const priceUsd = Number(p.price) * scale;
  const confIntervalUsd =
    typeof p.conf === 'string' ? Number(p.conf) * scale : Number.POSITIVE_INFINITY;
  // Stale if the publish time is older than 60s.
  const publishMs = typeof p.publish_time === 'number' ? p.publish_time * 1000 : 0;
  const stale = !Number.isFinite(priceUsd) || priceUsd <= 0 || Date.now() - publishMs > 60_000;
  return { priceUsd, confIntervalUsd, stale };
}

// The size-aware pre-graduation curve mark, via the venue's live pool. The
// venue's sellQuote returns the quote-out (in the pool's quote asset, SOL for a
// SOL-quoted curve) for selling the whole held balance; per-token is that
// divided by the human balance.
function curveMarkVia(venue: LaunchVenue | null) {
  return async (
    poolAddress: string,
    heldBalanceBase: bigint,
    decimals: number,
  ): Promise<CurveMark | null> => {
    if (venue === null) return null;
    const quoteOutBase = await venue.sellQuote(poolAddress, heldBalanceBase);
    if (quoteOutBase === null || quoteOutBase <= 0n) return null;
    const humanBalance = Number(heldBalanceBase) / 10 ** decimals;
    if (humanBalance <= 0) return null;
    // The quote asset is SOL (9 decimals) for a SOL-quoted curve.
    const quoteOutHuman = Number(quoteOutBase) / 10 ** 9;
    const sizeAware = quoteOutHuman / humanBalance;
    return { sizeAwareQuotePerToken: sizeAware, spotQuotePerToken: sizeAware };
  };
}

export function realPriceSources(venue: LaunchVenue | null): PriceSources {
  return {
    jupiterPrices,
    birdeyePrice,
    dexScreenerPrice,
    pythSolUsd,
    curveMark: curveMarkVia(venue),
  };
}

export { WSOL_MINT };
