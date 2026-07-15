// Realm token launchpad panel (src/ui/realm_launchpad.ts): the thin DOM
// consumer, driven against a hand-rolled fake DOM (no jsdom, the repo
// pattern) and a fake Api. Covers the two facts the new public discovery
// entry point (src/ui/realm_launches.ts) depends on: (1) a NON-OWNER can
// open this same panel end to end (the entry point this task adds reaches a
// non-owner here), and (2) the founder-only sections (register / open-vote /
// configure-presale / finalize) render ONLY when the server's `isOwner` flag
// is true, so a non-owner sees vote/contribute controls but never founder
// config. The gate is read straight off the real API response, not a fixed
// true/false in the panel, so a flipped isOwner flips what renders.

import { describe, expect, it, vi } from 'vitest';
import type { Api, RealmTokenPage } from '../src/net/online';
import { RealmLaunchpad } from '../src/ui/realm_launchpad';

class FakeEl {
  innerHTML = '';
  addEventListener(): void {}
  querySelector(_sel: string): FakeEl | null {
    // The panel assigns innerHTML then queries specific ids to wire click
    // handlers; returning a fresh no-op element for every query is enough to
    // let render()+wire() run without throwing, since the assertions below
    // read the rendered innerHTML string directly rather than the DOM.
    return new FakeEl();
  }
}

function makePanel(page: RealmTokenPage) {
  const root = new FakeEl();
  const close = vi.fn();
  const api = { realmToken: async () => page } as unknown as Api;
  const panel = new RealmLaunchpad(root as unknown as HTMLElement, {
    api,
    realm: { realmId: 9, name: 'Aldrin' },
    linkedWallet: () => 'MyWallet111',
    ensureWalletReady: async () => 'MyWallet111',
    signContribution: async () => 'sig',
    close,
  });
  return { root, panel, close };
}

function presalePage(over: { isOwner: boolean }): RealmTokenPage {
  return {
    token: {
      realmId: 9,
      symbol: 'ALD',
      icon: '',
      status: 'presale',
      monetizationPolicy: 'cosmetic',
      mint: null,
      decimals: 9,
    },
    vote: null,
    presale: {
      configured: true,
      status: 'presale',
      escrowWallet: 'EscrowWallet1',
      progressBps: 3000,
      softCapMet: false,
      rails: [
        {
          currency: 'SOL',
          mint: 'So11111111111111111111111111111111111111112',
          decimals: 9,
          native: true,
          softCapBase: '1000000000',
          raiseCapBase: '2000000000',
          walletCapBase: '500000000',
          raisedBase: '300000000',
          myContributedBase: '0',
          myRemainingBase: '500000000',
        },
      ],
      refund: null,
    },
    isOwner: over.isOwner,
  };
}

describe('RealmLaunchpad (owner and non-owner panel gating)', () => {
  it('a non-owner opens the panel without error and sees the presale contribute control', async () => {
    const { root, panel } = makePanel(presalePage({ isOwner: false }));
    await panel.open();
    expect(root.innerHTML).toContain('id="lp-contribute"');
  });

  it('hides the finalize control from a non-owner on an open, configured presale', async () => {
    const { root, panel } = makePanel(presalePage({ isOwner: false }));
    await panel.open();
    expect(root.innerHTML.includes('id="lp-finalize"')).toBe(false);
  });

  it('shows the finalize control to the owner on the SAME presale state', async () => {
    const { root, panel } = makePanel(presalePage({ isOwner: true }));
    await panel.open();
    expect(root.innerHTML).toContain('id="lp-finalize"');
  });

  it('hides the register control from a non-owner when no token is registered yet', async () => {
    const page: RealmTokenPage = { token: null, vote: null, presale: null, isOwner: false };
    const { root, panel } = makePanel(page);
    await panel.open();
    expect(root.innerHTML.includes('id="lp-register"')).toBe(false);
  });

  it('shows the register control to the owner when no token is registered yet', async () => {
    const page: RealmTokenPage = { token: null, vote: null, presale: null, isOwner: true };
    const { root, panel } = makePanel(page);
    await panel.open();
    expect(root.innerHTML).toContain('id="lp-register"');
  });

  it('hides the presale-configure control from a non-owner before contributions open', async () => {
    const page: RealmTokenPage = {
      token: {
        realmId: 9,
        symbol: 'ALD',
        icon: '',
        status: 'presale',
        monetizationPolicy: 'cosmetic',
        mint: null,
        decimals: 9,
      },
      vote: null,
      presale: {
        configured: false,
        status: 'presale',
        escrowWallet: null,
        progressBps: 0,
        softCapMet: false,
        rails: [],
        refund: null,
      },
      isOwner: false,
    };
    const { root, panel } = makePanel(page);
    await panel.open();
    expect(root.innerHTML.includes('id="lp-config-submit"')).toBe(false);
  });
});
