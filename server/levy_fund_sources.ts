// Live price/holdings sources for the Levy Street Fund keeper (phase 6). Thin
// fetch wrappers in the solana_rpc.ts style: every failure maps to null (or an
// empty map) so the valuation treats "can't read" as "not priced", never as
// zero. The curve quote lives in realm_launchpad_dbc.ts (the one SDK module);
// this module is raw REST only.
//
//  - Wallet holdings: getTokenAccountsByOwner under BOTH token programs,
//    joined by the caller to the realm token registry.
//  - Jupiter Price API v3 (lite), batched up to 50 mints per call.
//  - Cross-check spot: Birdeye when an API key is configured, DEX Screener's
//    most liquid pair otherwise.
//  - SOL/USD: one Pyth Hermes pull carrying the confidence band + staleness.

import { SPL_TOKEN_2022_PROGRAM, SPL_TOKEN_PROGRAM, solanaRpc } from './solana_rpc';
import type { PythSolUsd } from './token_valuation';

const JUPITER_PRICE_API = (
  process.env.JUPITER_PRICE_API ?? 'https://lite-api.jup.ag/price/v3'
).trim();
const BIRDEYE_API = (process.env.BIRDEYE_API ?? 'https://public-api.birdeye.so').trim();
const DEXSCREENER_API = (
  process.env.DEXSCREENER_API ?? 'https://api.dexscreener.com/latest/dex'
).trim();
const PYTH_HERMES_URL = (process.env.PYTH_HERMES_URL ?? 'https://hermes.pyth.network').trim();
// The canonical Pyth SOL/USD price feed id.
const PYTH_SOL_USD_FEED = (
  process.env.PYTH_SOL_USD_FEED ??
  'ef0d8b6fda2ceba41da15d4095d1da392a0d2f8ed0c6c7bc0f4cfac8c280b56d'
).trim();
const PYTH_STALE_SECONDS = 120;

// Sum the wallet's balances per mint across both token programs. Null on any
// RPC failure (the keeper keeps the previous snapshot rather than publishing
// a partial wallet).
export async function walletBalancesByMint(owner: string): Promise<Map<string, bigint> | null> {
  const out = new Map<string, bigint>();
  for (const programId of [SPL_TOKEN_PROGRAM, SPL_TOKEN_2022_PROGRAM]) {
    const res = await solanaRpc<{
      value?: Array<{
        account?: {
          data?: { parsed?: { info?: { mint?: string; tokenAmount?: { amount?: string } } } };
        };
      }>;
    }>('getTokenAccountsByOwner', [owner, { programId }, { encoding: 'jsonParsed' }]);
    if (!res) return null;
    for (const row of res.value ?? []) {
      const info = row.account?.data?.parsed?.info;
      const amount = info?.tokenAmount?.amount;
      if (typeof info?.mint !== 'string' || typeof amount !== 'string') continue;
      if (!/^[0-9]+$/.test(amount)) continue;
      out.set(info.mint, (out.get(info.mint) ?? 0n) + BigInt(amount));
    }
  }
  return out;
}

// Jupiter Price v3, batched 50 ids per call. Missing/null routes are simply
// absent from the map (the PRD's tolerate-null rule).
export async function jupiterPricesUsd(mints: string[]): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  for (let i = 0; i < mints.length; i += 50) {
    const batch = mints.slice(i, i + 50);
    try {
      const res = await fetch(`${JUPITER_PRICE_API}?ids=${batch.join(',')}`, {
        signal: AbortSignal.timeout(8000),
      });
      if (!res.ok) continue;
      const data = (await res.json()) as Record<string, unknown>;
      // v3 keys the payload by mint; tolerate a v2-style {data:{...}} nest.
      const table = (data.data && typeof data.data === 'object' ? data.data : data) as Record<
        string,
        { usdPrice?: unknown; price?: unknown } | null
      >;
      for (const mint of batch) {
        const entry = table[mint];
        if (!entry) continue;
        const price = Number(entry.usdPrice ?? entry.price);
        if (Number.isFinite(price) && price > 0) out.set(mint, price);
      }
    } catch {
      // batch unreadable: those mints stay unpriced
    }
  }
  return out;
}

// The cross-check spot: Birdeye (keyed) or DEX Screener's most liquid pair.
export async function crossPriceUsd(mint: string): Promise<number | null> {
  const birdeyeKey = (process.env.BIRDEYE_API_KEY ?? '').trim();
  if (birdeyeKey.length > 0) {
    try {
      const res = await fetch(`${BIRDEYE_API}/defi/price?address=${mint}`, {
        headers: { 'X-API-KEY': birdeyeKey, 'x-chain': 'solana' },
        signal: AbortSignal.timeout(8000),
      });
      if (res.ok) {
        const data = (await res.json()) as { data?: { value?: unknown } };
        const price = Number(data.data?.value);
        if (Number.isFinite(price) && price > 0) return price;
      }
    } catch {
      // fall through to DEX Screener
    }
  }
  try {
    const res = await fetch(`${DEXSCREENER_API}/tokens/${mint}`, {
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) return null;
    const data = (await res.json()) as {
      pairs?: Array<{ priceUsd?: unknown; liquidity?: { usd?: unknown } }>;
    };
    let best: { price: number; liquidity: number } | null = null;
    for (const pair of data.pairs ?? []) {
      const price = Number(pair.priceUsd);
      const liquidity = Number(pair.liquidity?.usd ?? 0);
      if (!Number.isFinite(price) || price <= 0) continue;
      if (!best || liquidity > best.liquidity) best = { price, liquidity };
    }
    return best ? best.price : null;
  } catch {
    return null;
  }
}

// One Pyth Hermes pull for SOL/USD with the confidence band + staleness flag.
export async function pythSolUsd(nowMs: number = Date.now()): Promise<PythSolUsd | null> {
  try {
    const res = await fetch(
      `${PYTH_HERMES_URL}/v2/updates/price/latest?ids%5B%5D=${PYTH_SOL_USD_FEED}&parsed=true`,
      { signal: AbortSignal.timeout(8000) },
    );
    if (!res.ok) return null;
    const data = (await res.json()) as {
      parsed?: Array<{
        price?: { price?: unknown; conf?: unknown; expo?: unknown; publish_time?: unknown };
      }>;
    };
    const p = data.parsed?.[0]?.price;
    if (!p) return null;
    const expo = Number(p.expo);
    const raw = Number(p.price);
    const conf = Number(p.conf);
    const publishTime = Number(p.publish_time);
    if (!Number.isFinite(expo) || !Number.isFinite(raw) || raw <= 0) return null;
    const price = raw * 10 ** expo;
    const confidence = Number.isFinite(conf) ? conf * 10 ** expo : 0;
    const stale = !Number.isFinite(publishTime) || nowMs / 1000 - publishTime > PYTH_STALE_SECONDS;
    return {
      price,
      confidenceBps: price > 0 ? Math.round((confidence / price) * 10_000) : 10_000,
      stale,
    };
  } catch {
    return null;
  }
}
