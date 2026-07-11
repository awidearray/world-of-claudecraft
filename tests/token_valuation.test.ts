// Launchpad phase 6 valuation core (server/token_valuation.ts): the tiered
// marks (size-aware curve quote pre-graduation, Jupiter primary with a
// cross-check post-graduation), the exclude-never-zero illiquid rule, the
// Pyth confidence downgrade, the rolling median, and the AUM clamp.

import { describe, expect, it } from 'vitest';
import {
  clampAum,
  DEFAULT_VALUATION_CONFIG,
  type HoldingInput,
  markHolding,
  type PythSolUsd,
  priceFromSqrtPrice,
  rollingMedian,
  totalAumUsd,
} from '../server/token_valuation';

const PYTH: PythSolUsd = { price: 150, confidenceBps: 20, stale: false };

function input(over: Partial<HoldingInput> = {}): HoldingInput {
  return {
    mint: 'Mint',
    realmId: 7,
    symbol: 'MOON',
    amountBase: 1_000n * 10n ** 9n, // 1000 tokens at 9dp
    decimals: 9,
    locked: false,
    graduated: false,
    curveQuoteOutBase: null,
    quoteIsSol: true,
    quoteDecimals: 9,
    jupiterUsd: null,
    crossUsd: null,
    ...over,
  };
}

describe('priceFromSqrtPrice', () => {
  it('squares the Q64.64 ratio with the decimal shift', () => {
    // sqrtPrice = 2^64 means price 1.0 at equal decimals.
    expect(priceFromSqrtPrice(1n << 64n, 9, 9)).toBeCloseTo(1);
    // Half the ratio: price 0.25; decimals shift by 10^(9-6).
    expect(priceFromSqrtPrice(1n << 63n, 9, 6)).toBeCloseTo(0.25 * 1000);
  });
});

describe('markHolding: curve tier (pre-graduation)', () => {
  it('marks from the realized quote-out, converted at the Pyth SOL price', () => {
    // Selling the whole bag realizes 10 SOL -> 1500 USD for 1000 tokens.
    const mark = markHolding(input({ curveQuoteOutBase: 10n * 10n ** 9n }), PYTH);
    expect(mark.illiquid).toBe(false);
    expect(mark.source).toBe('curve');
    expect(mark.valueUsd).toBeCloseTo(1500);
    expect(mark.priceUsd).toBeCloseTo(1.5);
    expect(mark.confidence).toBe('high');
  });

  it('excludes (never zeroes) an unquotable curve holding', () => {
    const mark = markHolding(input(), PYTH);
    expect(mark).toMatchObject({ illiquid: true, priceUsd: null, valueUsd: null, source: 'none' });
  });

  it('downgrades confidence on a wide or stale Pyth band, and excludes with none', () => {
    const wide = markHolding(input({ curveQuoteOutBase: 10n ** 9n }), {
      price: 150,
      confidenceBps: 999,
      stale: false,
    });
    expect(wide.confidence).toBe('low');
    expect(wide.illiquid).toBe(false); // flagged, still counted
    const stale = markHolding(input({ curveQuoteOutBase: 10n ** 9n }), {
      price: 150,
      confidenceBps: 10,
      stale: true,
    });
    expect(stale.confidence).toBe('low');
    expect(markHolding(input({ curveQuoteOutBase: 10n ** 9n }), null).illiquid).toBe(true);
  });

  it('values a stable quote asset at par without Pyth', () => {
    const mark = markHolding(
      input({
        curveQuoteOutBase: 2_500_000n, // 2.5 USDC
        quoteIsSol: false,
        quoteDecimals: 6,
      }),
      null,
    );
    expect(mark.valueUsd).toBeCloseTo(2.5);
    expect(mark.confidence).toBe('medium');
  });
});

describe('markHolding: DEX tier (post-graduation)', () => {
  it('prices from Jupiter and upgrades confidence on a passing cross-check', () => {
    const mark = markHolding(input({ graduated: true, jupiterUsd: 2, crossUsd: 2.1 }), PYTH);
    expect(mark.source).toBe('jupiter');
    expect(mark.priceUsd).toBe(2);
    expect(mark.valueUsd).toBeCloseTo(2000);
    expect(mark.confidence).toBe('high');
  });

  it('marks ILLIQUID on divergence beyond the threshold, and on a missing primary', () => {
    // 2 vs 3: 33 percent divergence, over the 25 percent default.
    const diverged = markHolding(input({ graduated: true, jupiterUsd: 2, crossUsd: 3 }), PYTH);
    expect(diverged.illiquid).toBe(true);
    expect(diverged.valueUsd).toBeNull();

    const unrouted = markHolding(input({ graduated: true }), PYTH);
    expect(unrouted.illiquid).toBe(true);
  });

  it('accepts Jupiter alone at medium confidence when no cross source exists', () => {
    const mark = markHolding(input({ graduated: true, jupiterUsd: 2 }), PYTH);
    expect(mark.illiquid).toBe(false);
    expect(mark.confidence).toBe('medium');
  });
});

describe('rollingMedian + clampAum + totalAumUsd', () => {
  it('median is exact for both parities and null when empty', () => {
    expect(rollingMedian([])).toBeNull();
    expect(rollingMedian([3])).toBe(3);
    expect(rollingMedian([5, 1, 3])).toBe(3);
    expect(rollingMedian([4, 1, 3, 2])).toBe(2.5);
  });

  it('clamps a single-refresh jump in either direction, publishing the previous total', () => {
    expect(clampAum(null, 500)).toEqual({ aumUsd: 500, clamped: false });
    expect(clampAum(1000, 1400)).toEqual({ aumUsd: 1400, clamped: false });
    expect(clampAum(1000, 1600)).toEqual({ aumUsd: 1000, clamped: true });
    expect(clampAum(1000, 600)).toEqual({ aumUsd: 1000, clamped: true });
  });

  it('AUM sums priced holdings only: illiquid rows are excluded, never zeroed', () => {
    const priced = markHolding(input({ graduated: true, jupiterUsd: 2 }), PYTH);
    const illiquid = markHolding(input({ graduated: true }), PYTH);
    expect(totalAumUsd([priced, illiquid])).toBeCloseTo(2000);
    // The illiquid row still exists as a row (shown, not silently dropped).
    expect(illiquid.mint).toBe('Mint');
    expect(DEFAULT_VALUATION_CONFIG.divergenceBps).toBe(2500);
  });
});
