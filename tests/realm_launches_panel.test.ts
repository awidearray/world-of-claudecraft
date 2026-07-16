// Public launch-discovery panel (src/ui/realm_launches.ts): the thin DOM
// consumer, driven against a hand-rolled fake DOM (no jsdom, the repo
// pattern) and a fake Api. Proves the list renders every voting/presale row
// with its status/progress, and that clicking a row's CTA opens the SAME
// realm_launchpad.ts panel via the host callback (the "non-owner can open
// the panel" path: this list is the entry point a non-owner reaches it from).

import { describe, expect, it, vi } from 'vitest';
import type { Api, LaunchpadDiscoveryEntry } from '../src/net/online';
import { RealmLaunches } from '../src/ui/realm_launches';

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

function votingEntry(over: Partial<LaunchpadDiscoveryEntry> = {}): LaunchpadDiscoveryEntry {
  return {
    realmId: 1,
    realmName: 'Moonlight',
    symbol: 'MOON',
    icon: '',
    status: 'voting',
    monetizationPolicy: 'cosmetic',
    vote: {
      status: 'voting',
      yesWeight: '1000000',
      noWeight: '0',
      voteCount: 1,
      quorumWoc: '2000000',
      yesThresholdBps: 6000,
      outcome: 'pending',
      myChoice: null,
      myWeightWoc: null,
    },
    presale: null,
    ...over,
  };
}

function presaleEntry(over: Partial<LaunchpadDiscoveryEntry> = {}): LaunchpadDiscoveryEntry {
  return {
    realmId: 2,
    realmName: 'Duskvale',
    symbol: 'DUSK',
    icon: '',
    status: 'presale',
    monetizationPolicy: 'power',
    vote: null,
    presale: {
      configured: true,
      status: 'presale',
      escrowWallet: 'Escrow1',
      progressBps: 3000,
      softCapMet: false,
      rails: [],
      refund: null,
    },
    ...over,
  };
}

function makePanel(entries: LaunchpadDiscoveryEntry[]) {
  const root = new FakeEl();
  root.child('[data-rl-back]');
  const body = root.child('[data-rl-body]');
  // Pre-register the per-row open-button hooks the panel wires after setting
  // innerHTML: FakeEl.querySelector only returns a pre-registered child (it
  // does not parse the HTML string), mirroring the levy_fund_panel.test.ts
  // pattern one level deeper (a dynamic, id-keyed selector per row).
  for (const e of entries) body.child(`[data-rl-open="${e.realmId}"]`);
  const close = vi.fn();
  const openRealm = vi.fn();
  const api = { launchpadDiscovery: async () => entries } as unknown as Api;
  const panel = new RealmLaunches(root as unknown as HTMLElement, { api, openRealm, close });
  return { root, panel, close, openRealm };
}

describe('RealmLaunches (public discovery list)', () => {
  it('renders one row per voting/presale realm with its status and CTA', async () => {
    const { root, panel } = makePanel([votingEntry(), presaleEntry()]);
    await panel.open();
    const html = root.querySelector('[data-rl-body]')?.innerHTML ?? '';
    expect(html).toContain('Moonlight');
    expect(html).toContain('Duskvale');
    expect(html).toContain('data-rl-open="1"');
    expect(html).toContain('data-rl-open="2"');
    // The power-realm tag renders for the presale entry, not the cosmetic one.
    expect(html).toContain('Pay-to-win');
  });

  it('renders the empty state when nothing is voting or in presale', async () => {
    const { root, panel } = makePanel([]);
    await panel.open();
    const html = root.querySelector('[data-rl-body]')?.innerHTML ?? '';
    expect(html).toContain('No realm is voting');
    expect(html.includes('data-rl-open')).toBe(false);
  });

  it('opening a discovered realm calls the host with that realm, the non-owner entry point', async () => {
    const { root, panel, openRealm } = makePanel([votingEntry()]);
    await panel.open();
    root
      .querySelector('[data-rl-body]')
      ?.querySelector('[data-rl-open="1"]')
      ?.listeners.get('click')?.();
    expect(openRealm).toHaveBeenCalledWith({ realmId: 1, name: 'Moonlight' });
  });

  it('wires the back button to the host close callback', async () => {
    const { root, panel, close } = makePanel([votingEntry()]);
    await panel.open();
    root.querySelector('[data-rl-back]')?.listeners.get('click')?.();
    expect(close).toHaveBeenCalledOnce();
  });

  it('falls back to the generic error copy when the list fails to load', async () => {
    const root = new FakeEl();
    root.child('[data-rl-back]');
    root.child('[data-rl-body]');
    const api = {
      launchpadDiscovery: async () => {
        throw new Error('network');
      },
    } as unknown as Api;
    const panel = new RealmLaunches(root as unknown as HTMLElement, {
      api,
      openRealm: vi.fn(),
      close: vi.fn(),
    });
    await panel.open();
    const html = root.querySelector('[data-rl-body]')?.innerHTML ?? '';
    expect(html).toContain('Something went wrong');
  });
});
