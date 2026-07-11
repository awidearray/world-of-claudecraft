// Launchpad phase 6 Levy Street Fund (server/levy_fund.ts): the valuation
// refresh (tiered pricing, median smoothing, illiquid-excluded-not-zeroed AUM,
// weights of included AUM, the AUM clamp), the public display-only portfolio
// read, and the source-scan pins that there is NO fund-share / redemption /
// buy-sell path anywhere (the securities bright line, PRD sections 8 + 14).

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  type LevyFundStore,
  type LevyHoldingRow,
  type LevyHoldingSource,
  type LevySnapshot,
  levyPortfolio,
  refreshLevyFund,
} from '../server/levy_fund';
import type { JupiterPrice, PriceSources } from '../server/token_valuation';

class FakeStore implements LevyFundStore {
  sources: LevyHoldingSource[] = [];
  marks = new Map<string, number[]>();
  snapshots: Array<{ id: number; aumUsd: number; holdings: LevyHoldingRow[]; clamped: boolean }> =
    [];
  private nextId = 1;

  async holdingSources() {
    return this.sources;
  }
  async recentMarks(mint: string, window: number) {
    return (this.marks.get(mint) ?? []).slice(-window);
  }
  async insertMark(mint: string, priceUsd: number) {
    const arr = this.marks.get(mint) ?? [];
    arr.push(priceUsd);
    this.marks.set(mint, arr);
  }
  async previousAum() {
    const last = this.snapshots[this.snapshots.length - 1];
    return last ? last.aumUsd : null;
  }
  async insertSnapshot(s: {
    aumUsd: number;
    aumSol: number | null;
    holdingCount: number;
    includedCount: number;
    clamped: boolean;
    solUsd: number | null;
    holdings: LevyHoldingRow[];
  }) {
    const id = this.nextId++;
    this.snapshots.push({ id, aumUsd: s.aumUsd, holdings: s.holdings, clamped: s.clamped });
    this.lastFull = { id, ...s };
    return id;
  }
  lastFull:
    | ({ id: number } & {
        aumUsd: number;
        aumSol: number | null;
        holdingCount: number;
        includedCount: number;
        clamped: boolean;
        solUsd: number | null;
        holdings: LevyHoldingRow[];
      })
    | null = null;
  async latestSnapshot(): Promise<LevySnapshot | null> {
    if (!this.lastFull) return null;
    return {
      snapshotId: this.lastFull.id,
      aumUsd: this.lastFull.aumUsd,
      aumSol: this.lastFull.aumSol,
      holdingCount: this.lastFull.holdingCount,
      includedCount: this.lastFull.includedCount,
      clamped: this.lastFull.clamped,
      solUsd: this.lastFull.solUsd,
      createdAt: new Date('2026-07-11T00:00:00Z'),
      holdings: this.lastFull.holdings,
    };
  }
}

function source(over: Partial<LevyHoldingSource> = {}): LevyHoldingSource {
  return {
    realmId: 1,
    mint: 'MintA',
    symbol: 'MOON',
    decimals: 9,
    levyAllocBase: 80_000_000n * 10n ** 9n, // 80M tokens (8% of a 1B supply)
    poolAddress: 'PoolA',
    status: 'graduated',
    levyLockAddress: 'LockA',
    ...over,
  };
}

function priceSources(over: Partial<PriceSources> = {}): PriceSources {
  return {
    jupiterPrices: async (mints) =>
      new Map<string, JupiterPrice>(mints.map((m) => [m, { mint: m, priceUsd: 0.01 }])),
    birdeyePrice: async () => ({ priceUsd: 0.0101, liquidityUsd: 50_000 }),
    dexScreenerPrice: async () => ({ priceUsd: 0.0099, liquidityUsd: 40_000 }),
    pythSolUsd: async () => ({ priceUsd: 150, confIntervalUsd: 0.1, stale: false }),
    curveMark: async () => ({ sizeAwareQuotePerToken: 0.0001, spotQuotePerToken: 0.0001 }),
    ...over,
  };
}

describe('refreshLevyFund', () => {
  it('values a graduated holding and writes an AUM snapshot with weights', async () => {
    const store = new FakeStore();
    store.sources = [source()];
    const id = await refreshLevyFund({ store, sources: priceSources() });
    expect(id).not.toBeNull();
    const snap = store.lastFull;
    expect(snap).not.toBeNull();
    if (!snap) return;
    // 80M tokens x 0.01 USD = 800,000 USD.
    expect(snap.aumUsd).toBeCloseTo(800_000, 2);
    expect(snap.includedCount).toBe(1);
    expect(snap.holdings[0].weightBps).toBe(10_000); // the sole holding is 100%
    expect(snap.holdings[0].illiquid).toBe(false);
  });

  it('EXCLUDES an illiquid holding from AUM (never zeroes) but keeps the row', async () => {
    const store = new FakeStore();
    store.sources = [
      source({ mint: 'Liquid', symbol: 'LIQ' }),
      source({ realmId: 2, mint: 'Illiquid', symbol: 'ILQ' }),
    ];
    const id = await refreshLevyFund({
      store,
      sources: priceSources({
        jupiterPrices: async () =>
          new Map<string, JupiterPrice>([['Liquid', { mint: 'Liquid', priceUsd: 0.01 }]]),
        // 'Illiquid' has no Jupiter route -> excluded.
      }),
    });
    expect(id).not.toBeNull();
    const snap = store.lastFull;
    if (!snap) return;
    expect(snap.holdingCount).toBe(2);
    expect(snap.includedCount).toBe(1);
    expect(snap.aumUsd).toBeCloseTo(800_000, 2);
    const illiquid = snap.holdings.find((h) => h.mint === 'Illiquid');
    expect(illiquid?.illiquid).toBe(true);
    expect(illiquid?.valueUsd).toBeNull(); // excluded, NOT zeroed
    expect(illiquid?.weightBps).toBe(0);
    expect(illiquid?.note).toBe('no Jupiter route');
  });

  it('applies the rolling median per mint', async () => {
    const store = new FakeStore();
    store.sources = [source()];
    // Prior marks establish a low baseline; a single high refresh is smoothed.
    store.marks.set('MintA', [0.01, 0.01, 0.01, 0.01]);
    await refreshLevyFund({
      store,
      sources: priceSources({
        // All sources agree at the high price (so it is liquid, not diverging);
        // the rolling median is what smooths it against the low baseline.
        jupiterPrices: async () =>
          new Map<string, JupiterPrice>([['MintA', { mint: 'MintA', priceUsd: 0.1 }]]),
        birdeyePrice: async () => ({ priceUsd: 0.1, liquidityUsd: 50_000 }),
        dexScreenerPrice: async () => ({ priceUsd: 0.1, liquidityUsd: 40_000 }),
      }),
    });
    const snap = store.lastFull;
    if (!snap) return;
    // median of [0.01,0.01,0.01,0.01,0.1] = 0.01, so AUM uses 0.01 not 0.1.
    expect(snap.holdings[0].priceUsd).toBeCloseTo(0.01, 6);
    expect(snap.aumUsd).toBeCloseTo(800_000, 2);
  });

  it('clamps a single-refresh AUM jump against the previous snapshot', async () => {
    const store = new FakeStore();
    store.sources = [source()];
    // First refresh sets the baseline at 800k.
    await refreshLevyFund({ store, sources: priceSources() });
    const baselineAum = store.lastFull?.aumUsd ?? 0;
    expect(baselineAum).toBeCloseTo(800_000, 2);
    // A consistent 10x across every source would 10x the AUM. Even with the
    // median lagging, the clamp caps the published jump at +50% of the baseline.
    const tenx = priceSources({
      jupiterPrices: async () =>
        new Map<string, JupiterPrice>([['MintA', { mint: 'MintA', priceUsd: 0.1 }]]),
      birdeyePrice: async () => ({ priceUsd: 0.1, liquidityUsd: 50_000 }),
      dexScreenerPrice: async () => ({ priceUsd: 0.1, liquidityUsd: 40_000 }),
    });
    // Enough refreshes for the median to fully catch up to the 10x price.
    for (let i = 0; i < 6; i++) await refreshLevyFund({ store, sources: tenx });
    // Each published AUM step never exceeds +50% of the prior; after several
    // steps it converges toward 8M but never leaped there in one refresh.
    let prev = baselineAum;
    for (const s of store.snapshots.slice(1)) {
      expect(s.aumUsd).toBeLessThanOrEqual(prev * 1.5 + 1);
      prev = s.aumUsd;
    }
    expect(store.lastFull?.aumUsd ?? 0).toBeGreaterThan(baselineAum);
  });

  it('returns null with no holdings', async () => {
    const store = new FakeStore();
    expect(await refreshLevyFund({ store, sources: priceSources() })).toBeNull();
  });
});

describe('levyPortfolio (display-only read)', () => {
  it('serves the latest snapshot with no buy/sell/redeem fields', async () => {
    const store = new FakeStore();
    store.sources = [source()];
    await refreshLevyFund({ store, sources: priceSources() });
    const view = await levyPortfolio(store);
    expect(view.aumUsd).toBeCloseTo(800_000, 2);
    expect(view.holdings).toHaveLength(1);
    expect(view.holdings[0]).toMatchObject({ symbol: 'MOON', illiquid: false });
    // The payload shape carries no control field.
    const json = JSON.stringify(view);
    for (const forbidden of ['buy', 'sell', 'redeem', 'redemption', 'shares', 'mintShare']) {
      expect(json.toLowerCase().includes(forbidden.toLowerCase())).toBe(false);
    }
  });

  it('is empty before the first snapshot', async () => {
    const view = await levyPortfolio(new FakeStore());
    expect(view.aumUsd).toBe(0);
    expect(view.holdings).toEqual([]);
    expect(view.updatedAt).toBeNull();
  });
});

describe('the securities bright line (source scan)', () => {
  it('the levy fund modules contain no mint / redeem / share / sell path', async () => {
    for (const file of ['levy_fund.ts', 'levy_fund_db.ts']) {
      const src = readFileSync(join(__dirname, '..', 'server', file), 'utf8');
      // Split identifiers so the scan targets real symbols, not the prose in
      // the header comments (which explains what is deliberately absent).
      const codeOnly = src
        .split('\n')
        .filter((l) => !l.trim().startsWith('//'))
        .join('\n');
      for (const needle of [
        'redeem',
        'redemption',
        'fundShare',
        'shareToken',
        'mintShare',
        'sellHolding',
        'withdrawHolding',
      ]) {
        expect(codeOnly.includes(needle), `${file} must not contain ${needle}`).toBe(false);
      }
    }
  });
});
