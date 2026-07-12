// Launchpad phase 6 portfolio panel (src/ui/levy_fund_panel.ts): the thin DOM
// consumer, driven against a hand-rolled fake DOM (the repo's pattern, no
// jsdom) and a fake Api. Proves the panel renders the AUM header, the
// DISPLAY-ONLY note (the securities-line copy), the holdings rows with the
// illiquid tag, the empty state, and wires the back button, all WITHOUT a
// browser. The pure render model is covered separately by levy_fund_view.test.ts.

import { describe, expect, it, vi } from 'vitest';
import type { Api, LevyPortfolioWire } from '../src/net/online';
import { LevyFundPanel } from '../src/ui/levy_fund_panel';

// A fake element modeling only the contract the panel uses: an innerHTML string,
// a querySelector that returns registered child fakes for the two data-hooks the
// panel queries, and addEventListener recording.
class FakeEl {
  innerHTML = '';
  private children = new Map<string, FakeEl>();
  readonly listeners = new Map<string, () => void>();
  child(sel: string): FakeEl {
    let c = this.children.get(sel);
    if (!c) {
      c = new FakeEl();
      this.children.set(sel, c);
    }
    return c;
  }
  querySelector(sel: string): FakeEl | null {
    return this.children.get(sel) ?? null;
  }
  addEventListener(type: string, cb: () => void): void {
    this.listeners.set(type, cb);
  }
}

function portfolio(over: Partial<LevyPortfolioWire> = {}): LevyPortfolioWire {
  return {
    aumUsd: 1_000_000,
    aumSol: 6_666,
    holdingCount: 2,
    includedCount: 1,
    clamped: false,
    solUsd: 150,
    updatedAt: '2026-07-11T00:00:00Z',
    holdings: [
      {
        realmId: 1,
        mint: 'MoonMint111111111111111111',
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
      },
      {
        realmId: 2,
        mint: 'IlqMint2222222222222222222',
        symbol: 'ILQ',
        amount: '5000000000',
        priceUsd: null,
        valueUsd: null,
        valueSol: null,
        weightBps: 0,
        source: 'jupiter_v3',
        illiquid: true,
        note: 'no route',
        lockAddress: 'LockB',
      },
    ],
    ...over,
  };
}

function makePanel(wire: LevyPortfolioWire) {
  const root = new FakeEl();
  // Pre-register the two hooks the panel queries after setting innerHTML.
  root.child('[data-levy-back]');
  root.child('[data-levy-body]');
  const close = vi.fn();
  const api = { levyFund: async () => wire } as unknown as Api;
  const panel = new LevyFundPanel(root as unknown as HTMLElement, { api, close });
  return { root, panel, close };
}

describe('LevyFundPanel', () => {
  it('renders the AUM header, the display-only note, and one row per holding', async () => {
    const { root, panel } = makePanel(portfolio());
    await panel.open();
    // The shell carries the display-only securities-line copy (rendered from the
    // catalog key, so it is the real localized string).
    expect(root.innerHTML).toContain('cannot sell');
    expect(root.innerHTML).toContain('no fund share');
    const body = root.querySelector('[data-levy-body]');
    expect(body).not.toBeNull();
    const html = body?.innerHTML ?? '';
    // AUM formatted, both symbols, the illiquid tag on the excluded row.
    expect(html).toContain('$1,000,000');
    expect(html).toContain('MOON');
    expect(html).toContain('ILQ');
    expect(html).toContain('illiquid');
    // The liquid row shows its weight percent; the illiquid row does not.
    expect(html).toContain('80%');
    // No control affordance anywhere in the rendered panel.
    for (const forbidden of ['data-buy', 'data-sell', 'data-redeem', 'Redeem']) {
      expect(html.includes(forbidden)).toBe(false);
    }
  });

  it('renders the empty state when the fund has no holdings', async () => {
    const { root, panel } = makePanel(
      portfolio({ aumUsd: 0, holdingCount: 0, includedCount: 0, updatedAt: null, holdings: [] }),
    );
    await panel.open();
    const html = root.querySelector('[data-levy-body]')?.innerHTML ?? '';
    // The empty copy, and no table.
    expect(html).toContain('No holdings yet');
    expect(html.includes('<table')).toBe(false);
  });

  it('wires the back button to the host close callback', async () => {
    const { root, panel, close } = makePanel(portfolio());
    await panel.open();
    root.querySelector('[data-levy-back]')?.listeners.get('click')?.();
    expect(close).toHaveBeenCalledOnce();
  });
});
