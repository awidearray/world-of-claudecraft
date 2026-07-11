// Launchpad phase 6 portfolio view-core (src/ui/levy_fund_view.ts): the pure
// AUM + holdings render model, value-desc sort with illiquid last, weight
// percents, and the empty state. No control affordance exists in the model.

import { describe, expect, it } from 'vitest';
import { type LevyPortfolioWire, levyPortfolioView } from '../src/ui/levy_fund_view';

function holding(over: Partial<LevyPortfolioWire['holdings'][number]> = {}) {
  return {
    realmId: 1,
    mint: 'MintA',
    symbol: 'MOON',
    amount: '80000000000000000',
    priceUsd: 0.01,
    valueUsd: 800_000,
    valueSol: 5_333,
    weightBps: 8000,
    source: 'jupiter_v3',
    illiquid: false,
    note: null,
    lockAddress: 'LockA',
    ...over,
  };
}

function wire(over: Partial<LevyPortfolioWire> = {}): LevyPortfolioWire {
  return {
    aumUsd: 1_000_000,
    aumSol: 6_666,
    holdingCount: 2,
    includedCount: 2,
    clamped: false,
    solUsd: 150,
    updatedAt: '2026-07-11T00:00:00Z',
    holdings: [holding(), holding({ symbol: 'STAR', valueUsd: 200_000, weightBps: 2000 })],
    ...over,
  };
}

describe('levyPortfolioView', () => {
  it('sorts by value desc and renders weights as percents', () => {
    const m = levyPortfolioView(wire());
    expect(m.aumUsd).toBe(1_000_000);
    expect(m.rows.map((r) => r.symbol)).toEqual(['MOON', 'STAR']);
    expect(m.rows[0].weightPct).toBe(80);
    expect(m.excludedCount).toBe(0);
    expect(m.empty).toBe(false);
  });

  it('pushes illiquid holdings to the bottom and counts them excluded', () => {
    const m = levyPortfolioView(
      wire({
        holdings: [
          holding({
            symbol: 'ILQ',
            illiquid: true,
            valueUsd: null,
            weightBps: 0,
            note: 'no route',
          }),
          holding({ symbol: 'MOON', valueUsd: 800_000 }),
        ],
      }),
    );
    expect(m.rows.map((r) => r.symbol)).toEqual(['MOON', 'ILQ']);
    expect(m.rows[1].illiquid).toBe(true);
    expect(m.rows[1].note).toBe('no route');
    expect(m.excludedCount).toBe(1);
  });

  it('renders the empty state before the first snapshot', () => {
    const m = levyPortfolioView(
      wire({ aumUsd: 0, holdingCount: 0, includedCount: 0, updatedAt: null, holdings: [] }),
    );
    expect(m.empty).toBe(true);
    expect(m.rows).toEqual([]);
    expect(m.updatedAt).toBeNull();
  });

  it('carries the clamp flag through', () => {
    expect(levyPortfolioView(wire({ clamped: true })).clamped).toBe(true);
  });
});
