// Launchpad phase 6 (server/levy_fund.ts): the fund keeper against in-memory
// fakes. Covers the position composition (wallet balances joined to the
// registry, verified levy locks as first-class LOCKED rows, foreign mints
// ignored), the refresh pipeline (per-tier pricing, median smoothing, AUM
// clamp, unreadable-chain no-op), and the display-only portfolio payload:
// weights, ordering, and the pinned ABSOLUTE LINE that no buy / sell / redeem
// surface exists anywhere in the module or its payload.

import { describe, expect, it } from 'vitest';
import * as levyFund from '../server/levy_fund';
import {
  composePositions,
  type FundPosition,
  type LevyFundDeps,
  type LevyFundSnapshot,
  type LevyFundSources,
  type LevyFundStore,
  portfolioView,
  refreshLevyFund,
} from '../server/levy_fund';
import type { HoldingMark } from '../server/token_valuation';

describe('composePositions', () => {
  const tokens = [
    {
      realmId: 1,
      mint: 'LiveMint',
      symbol: 'LIVE',
      decimals: 9,
      status: 'live',
      curveAddress: 'Pool1',
    },
    {
      realmId: 2,
      mint: 'GradMint',
      symbol: 'GRAD',
      decimals: 9,
      status: 'graduated',
      curveAddress: 'Pool2',
    },
  ];

  it('joins balances to the registry and ignores foreign mints', () => {
    const positions = composePositions({
      balances: new Map([
        ['LiveMint', 100n],
        ['GradMint', 200n],
        ['SomeDustMint', 999n],
      ]),
      tokens,
      levyLocks: [],
    });
    expect(positions).toHaveLength(2);
    const live = positions.find((p) => p.mint === 'LiveMint');
    expect(live).toMatchObject({ locked: false, graduated: false, curveAddress: 'Pool1' });
    const grad = positions.find((p) => p.mint === 'GradMint');
    expect(grad).toMatchObject({ locked: false, graduated: true, curveAddress: null });
  });

  it('adds each verified levy lock as a LOCKED row', () => {
    const positions = composePositions({
      balances: new Map(),
      tokens,
      levyLocks: [
        {
          realmId: 1,
          mint: 'LiveMint',
          symbol: 'LIVE',
          decimals: 9,
          status: 'live',
          curveAddress: 'Pool1',
          levyBase: 80n,
        },
      ],
    });
    expect(positions).toHaveLength(1);
    expect(positions[0]).toMatchObject({ locked: true, amountBase: 80n, curveAddress: 'Pool1' });
  });
});

// ── Refresh pipeline ─────────────────────────────────────────────────────────

class FakeStore implements LevyFundStore {
  saved: Parameters<LevyFundStore['saveSnapshot']>[0] | null = null;
  previous: number | null = null;
  marks = new Map<string, number[]>();
  async saveSnapshot(snapshot: Parameters<LevyFundStore['saveSnapshot']>[0]): Promise<void> {
    this.saved = snapshot;
  }
  async readSnapshot(): Promise<LevyFundSnapshot | null> {
    return null;
  }
  async previousAumUsd(): Promise<number | null> {
    return this.previous;
  }
  async recentMarks(mint: string, limit: number): Promise<number[]> {
    return (this.marks.get(mint) ?? []).slice(0, limit);
  }
  async appendMark(mint: string, priceUsd: number): Promise<void> {
    this.marks.set(mint, [priceUsd, ...(this.marks.get(mint) ?? [])]);
  }
}

function sources(over: Partial<LevyFundSources> = {}): LevyFundSources {
  return {
    listPositions: async () => [
      {
        mint: 'LiveMint',
        realmId: 1,
        symbol: 'LIVE',
        amountBase: 1000n * 10n ** 9n,
        decimals: 9,
        locked: true,
        graduated: false,
        curveAddress: 'Pool1',
      },
      {
        mint: 'GradMint',
        realmId: 2,
        symbol: 'GRAD',
        amountBase: 500n * 10n ** 9n,
        decimals: 9,
        locked: false,
        graduated: true,
        curveAddress: null,
      },
    ],
    curveQuoteOut: async () => ({
      quoteOutBase: 10n * 10n ** 9n, // 10 SOL realized
      quoteIsSol: true,
      quoteDecimals: 9,
    }),
    jupiterPricesUsd: async (mints) => new Map(mints.map((m) => [m, 2])),
    crossPriceUsd: async () => 2.1,
    pythSolUsd: async () => ({ price: 150, confidenceBps: 20, stale: false }),
    ...over,
  };
}

function deps(store: FakeStore, s: LevyFundSources): LevyFundDeps {
  return { sources: s, store, fundWallet: 'FundWallet', medianWindow: 5 };
}

describe('refreshLevyFund', () => {
  it('prices each tier and publishes the priced AUM', async () => {
    const store = new FakeStore();
    expect(await refreshLevyFund(deps(store, sources()))).toBe(true);
    const saved = store.saved;
    expect(saved).not.toBeNull();
    if (!saved) return;
    // Curve holding: 10 SOL * 150 = 1500; DEX holding: 500 * 2 = 1000.
    expect(saved.aumUsd).toBeCloseTo(2500);
    expect(saved.aumClamped).toBe(false);
    expect(saved.solUsd).toBe(150);
    const locked = saved.holdings.find((h: HoldingMark) => h.locked);
    expect(locked?.source).toBe('curve');
    expect(locked?.valueUsd).toBeCloseTo(1500);
  });

  it('keeps the previous snapshot when the chain is unreadable', async () => {
    const store = new FakeStore();
    const ok = await refreshLevyFund(deps(store, sources({ listPositions: async () => null })));
    expect(ok).toBe(false);
    expect(store.saved).toBeNull();
  });

  it('clamps a single-refresh AUM jump against the stored previous total', async () => {
    const store = new FakeStore();
    store.previous = 100; // last published total; the new 2500 is a >1.5x jump
    await refreshLevyFund(deps(store, sources()));
    expect(store.saved?.aumUsd).toBe(100);
    expect(store.saved?.aumClamped).toBe(true);
  });

  it('median-smooths the published price over the recent marks', async () => {
    const store = new FakeStore();
    store.marks.set('GradMint', [4, 6]); // history; this refresh adds 2
    await refreshLevyFund(deps(store, sources()));
    const grad = store.saved?.holdings.find((h: HoldingMark) => h.mint === 'GradMint');
    // median(2, 4, 6) = 4, not this refresh's spot of 2.
    expect(grad?.priceUsd).toBe(4);
    expect(grad?.valueUsd).toBeCloseTo(2000);
  });

  it('excluded holdings stay visible rows with no value', async () => {
    const store = new FakeStore();
    await refreshLevyFund(
      deps(
        store,
        sources({ jupiterPricesUsd: async () => new Map(), crossPriceUsd: async () => null }),
      ),
    );
    const grad = store.saved?.holdings.find((h: HoldingMark) => h.mint === 'GradMint');
    expect(grad?.illiquid).toBe(true);
    expect(grad?.valueUsd).toBeNull();
    expect(store.saved?.aumUsd).toBeCloseTo(1500); // curve holding only
  });
});

// ── Display-only portfolio payload ───────────────────────────────────────────

describe('portfolioView', () => {
  const snapshot: LevyFundSnapshot = {
    aumUsd: 3000,
    aumClamped: false,
    solUsd: 150,
    updatedAt: '2026-07-11T00:00:00.000Z',
    holdings: [
      {
        mint: 'A',
        realmId: 1,
        symbol: 'AAA',
        amountBase: '1',
        decimals: 9,
        locked: true,
        graduated: false,
        priceUsd: 1,
        valueUsd: 1000,
        weightBps: 0,
        source: 'curve',
        confidence: 'high',
        illiquid: false,
      },
      {
        mint: 'B',
        realmId: 2,
        symbol: 'BBB',
        amountBase: '1',
        decimals: 9,
        locked: false,
        graduated: true,
        priceUsd: 2,
        valueUsd: 2000,
        weightBps: 0,
        source: 'jupiter',
        confidence: 'high',
        illiquid: false,
      },
      {
        mint: 'C',
        realmId: 3,
        symbol: 'CCC',
        amountBase: '1',
        decimals: 9,
        locked: false,
        graduated: true,
        priceUsd: null,
        valueUsd: null,
        weightBps: 0,
        source: 'none',
        confidence: 'low',
        illiquid: true,
      },
    ],
  };

  it('computes weights of the priced AUM and sorts by value with illiquid last', () => {
    const view = portfolioView(snapshot);
    expect(view?.holdings.map((h) => h.mint)).toEqual(['B', 'A', 'C']);
    expect(view?.holdings[0].weightBps).toBe(6667);
    expect(view?.holdings[1].weightBps).toBe(3333);
    expect(view?.holdings[2].weightBps).toBe(0);
    expect(portfolioView(null)).toBeNull();
  });

  it('ABSOLUTE LINE: no buy, sell, redeem, or share surface exists', () => {
    // The module exports no trading operation of any kind.
    const exported = Object.keys(levyFund).join(' ').toLowerCase();
    for (const banned of ['buy', 'sell', 'redeem', 'swap', 'order', 'share']) {
      expect(exported.includes(banned), banned).toBe(false);
    }
    // And the public payload carries no such field on any row or the root.
    const view = portfolioView(snapshot);
    const keys = [...Object.keys(view ?? {}), ...Object.keys(view?.holdings[0] ?? {})].map((k) =>
      k.toLowerCase(),
    );
    for (const key of keys) {
      for (const banned of ['buy', 'sell', 'redeem', 'swap', 'order', 'share']) {
        expect(key.includes(banned), key).toBe(false);
      }
    }
  });
});
