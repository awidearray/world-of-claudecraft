// Launchpad phase 6 valuation (server/token_valuation.ts): the sqrtPrice math,
// the tiered pipeline (pre-grad curve mark, post-grad Jupiter + cross-check),
// the divergence + liquidity-floor + Pyth-confidence rejections that EXCLUDE
// (never zero) a holding, the rolling median, and the AUM clamp.

import { afterEach, describe, expect, it } from 'vitest';
import {
  aumClampFraction,
  type CurveMark,
  clampAumJump,
  type JupiterPrice,
  type PriceSources,
  type PythSolUsd,
  priceFromSqrtPriceScaled,
  pythReliable,
  rollingMedianUsd,
  valueHolding,
} from '../server/token_valuation';

const ENV = [
  'LEVY_PRICE_DIVERGENCE_MAX',
  'LEVY_LIQUIDITY_FLOOR_USD',
  'LEVY_PYTH_CONF_MAX',
  'LEVY_AUM_CLAMP_MAX',
];
afterEach(() => {
  for (const k of ENV) delete process.env[k];
});

describe('priceFromSqrtPriceScaled', () => {
  it('converts a Q64.64 sqrtPrice to a scaled human price', () => {
    // sqrtPrice = 2^64 means price = 1.0 (same decimals) -> PRICE_SCALE.
    const one = 1n << 64n;
    expect(priceFromSqrtPriceScaled(one, 9, 9)).toBe(10n ** 18n);
    // 2x the sqrtPrice -> 4x the price.
    expect(priceFromSqrtPriceScaled(2n << 64n, 9, 9)).toBe(4n * 10n ** 18n);
    // A decimal shift scales by 10^(base-quote).
    expect(priceFromSqrtPriceScaled(one, 6, 9)).toBe(10n ** 18n / 1000n);
  });
});

function sources(over: Partial<PriceSources> = {}): PriceSources {
  return {
    jupiterPrices: async () => new Map(),
    birdeyePrice: async () => ({ priceUsd: null, liquidityUsd: null }),
    dexScreenerPrice: async () => ({ priceUsd: null, liquidityUsd: null }),
    pythSolUsd: async () => ({ priceUsd: 150, confIntervalUsd: 0.1, stale: false }),
    curveMark: async () => null,
    ...over,
  };
}

const RELIABLE_SOL = { priceUsd: 150, reliable: true };

describe('valueHolding pre-graduation (curve)', () => {
  const holding = {
    mint: 'MintA',
    decimals: 9,
    amountBase: 1_000_000_000_000_000n, // 1,000,000 whole tokens
    graduated: false,
    poolAddress: 'PoolA',
  };

  it('marks a holding size-aware off the curve, converted via Pyth', async () => {
    const curveMark: CurveMark = { sizeAwareQuotePerToken: 0.0002, spotQuotePerToken: 0.0003 };
    const v = await valueHolding(
      holding,
      sources({ curveMark: async () => curveMark }),
      new Map(),
      RELIABLE_SOL,
    );
    expect(v.illiquid).toBe(false);
    expect(v.source).toBe('dbc_curve');
    // 1,000,000 tokens x 0.0002 SOL x 150 USD/SOL = 30,000 USD.
    expect(v.valueUsd).toBeCloseTo(30_000, 4);
    expect(v.valueSol).toBeCloseTo(200, 6);
  });

  it('EXCLUDES (never zeroes) when the curve cannot quote the size', async () => {
    const v = await valueHolding(
      holding,
      sources({
        curveMark: async () => ({ sizeAwareQuotePerToken: null, spotQuotePerToken: 0.1 }),
      }),
      new Map(),
      RELIABLE_SOL,
    );
    expect(v.illiquid).toBe(true);
    expect(v.valueUsd).toBeNull();
    expect(v.priceUsd).toBeNull();
    expect(v.note).toBe('curve cannot quote size');
  });

  it('excludes when SOL/USD is unreliable', async () => {
    const v = await valueHolding(
      holding,
      sources({
        curveMark: async () => ({ sizeAwareQuotePerToken: 0.0002, spotQuotePerToken: 0.0002 }),
      }),
      new Map(),
      { priceUsd: 150, reliable: false },
    );
    expect(v.illiquid).toBe(true);
    expect(v.note).toBe('SOL/USD unreliable');
  });
});

describe('valueHolding post-graduation (Jupiter + cross-check)', () => {
  const holding = {
    mint: 'MintB',
    decimals: 9,
    amountBase: 1_000_000_000_000_000n, // 1,000,000 tokens
    graduated: true,
    poolAddress: null,
  };
  const jup = (price: number) =>
    new Map<string, JupiterPrice>([['MintB', { mint: 'MintB', priceUsd: price }]]);

  it('values off Jupiter when a cross-check agrees within the threshold', async () => {
    const v = await valueHolding(
      holding,
      sources({
        birdeyePrice: async () => ({ priceUsd: 0.021, liquidityUsd: 10_000 }),
        dexScreenerPrice: async () => ({ priceUsd: 0.0205, liquidityUsd: 8_000 }),
      }),
      jup(0.02),
      RELIABLE_SOL,
    );
    expect(v.illiquid).toBe(false);
    expect(v.source).toBe('jupiter_v3');
    expect(v.valueUsd).toBeCloseTo(20_000, 4);
    expect(v.valueSol).toBeCloseTo(133.333, 2);
  });

  it('excludes when there is no Jupiter route', async () => {
    const v = await valueHolding(holding, sources(), new Map(), RELIABLE_SOL);
    expect(v.illiquid).toBe(true);
    expect(v.note).toBe('no Jupiter route');
  });

  it('excludes when the cross-check price diverges beyond the threshold', async () => {
    const v = await valueHolding(
      holding,
      sources({
        birdeyePrice: async () => ({ priceUsd: 0.05, liquidityUsd: 10_000 }), // 150% higher
        dexScreenerPrice: async () => ({ priceUsd: null, liquidityUsd: null }),
      }),
      jup(0.02),
      RELIABLE_SOL,
    );
    expect(v.illiquid).toBe(true);
    expect(v.note).toBe('price sources diverge');
  });

  it('excludes when the deepest cross-check pool is below the liquidity floor', async () => {
    process.env.LEVY_LIQUIDITY_FLOOR_USD = '5000';
    const v = await valueHolding(
      holding,
      sources({
        birdeyePrice: async () => ({ priceUsd: 0.0205, liquidityUsd: 100 }),
        dexScreenerPrice: async () => ({ priceUsd: 0.0205, liquidityUsd: 200 }),
      }),
      jup(0.02),
      RELIABLE_SOL,
    );
    expect(v.illiquid).toBe(true);
    expect(v.note).toBe('pool liquidity below floor');
  });

  it('excludes when no cross-check source has data', async () => {
    const v = await valueHolding(holding, sources(), jup(0.02), RELIABLE_SOL);
    expect(v.illiquid).toBe(true);
    expect(v.note).toBe('no cross-check source');
  });
});

describe('pythReliable', () => {
  const p = (over: Partial<PythSolUsd>): PythSolUsd => ({
    priceUsd: 150,
    confIntervalUsd: 0.5,
    stale: false,
    ...over,
  });
  it('accepts a tight, fresh band and rejects stale / wide / nonpositive', () => {
    expect(pythReliable(p({}))).toBe(true);
    expect(pythReliable(p({ stale: true }))).toBe(false);
    expect(pythReliable(p({ confIntervalUsd: 20 }))).toBe(false); // >5% band
    expect(pythReliable(p({ priceUsd: 0 }))).toBe(false);
  });
});

describe('rollingMedianUsd', () => {
  it('smooths a single spike within the window', () => {
    // recent [10, 10, 10], fresh 100, window 5 -> median of [10,10,10,100] = 10.
    expect(rollingMedianUsd([10, 10, 10], 100, 5)).toBe(10);
    // A sustained move eventually carries the median.
    expect(rollingMedianUsd([100, 100, 100], 100, 5)).toBe(100);
    // Even-length averages the two middles.
    expect(rollingMedianUsd([10, 20], 30, 5)).toBe(20);
  });

  it('honors the window (drops the oldest)', () => {
    expect(rollingMedianUsd([1, 2, 3, 4], 5, 3)).toBe(4); // last 3 = [3,4,5]
  });
});

describe('clampAumJump', () => {
  it('clamps a spike to the bound and passes a normal move', () => {
    expect(clampAumJump(1000, 5000, 0.5)).toEqual({ aum: 1500, clamped: true });
    expect(clampAumJump(1000, 100, 0.5)).toEqual({ aum: 500, clamped: true });
    expect(clampAumJump(1000, 1200, 0.5)).toEqual({ aum: 1200, clamped: false });
    expect(clampAumJump(null, 9999, 0.5)).toEqual({ aum: 9999, clamped: false });
  });

  it('reads the clamp fraction from env', () => {
    expect(aumClampFraction()).toBe(0.5);
    process.env.LEVY_AUM_CLAMP_MAX = '0.2';
    expect(aumClampFraction()).toBe(0.2);
  });
});
