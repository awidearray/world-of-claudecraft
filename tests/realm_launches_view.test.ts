// Pure view-core for the public launch-discovery list (src/ui/realm_launches_view.ts):
// maps the GET /api/realms/launchpad payload into one row per realm, reusing
// voteView/presaleView so the discovery list's progress numbers can never
// drift from the same panel's owner-facing math.

import { describe, expect, it } from 'vitest';
import { type LaunchpadDiscoveryWire, launchpadDiscoveryView } from '../src/ui/realm_launches_view';
import type { PresaleWire, VoteWire } from '../src/ui/realm_launchpad_view';

function vote(over: Partial<VoteWire> = {}): VoteWire {
  return {
    status: 'voting',
    yesWeight: '600000',
    noWeight: '400000',
    voteCount: 2,
    quorumWoc: '2000000',
    yesThresholdBps: 6000,
    outcome: 'pending',
    myChoice: null,
    myWeightWoc: null,
    ...over,
  };
}

function presale(over: Partial<PresaleWire> = {}): PresaleWire {
  return {
    configured: true,
    status: 'presale',
    escrowWallet: 'Escrow111',
    progressBps: 4500,
    softCapMet: false,
    rails: [],
    refund: null,
    ...over,
  };
}

function entry(over: Partial<LaunchpadDiscoveryWire> = {}): LaunchpadDiscoveryWire {
  return {
    realmId: 1,
    realmName: 'Moonlight',
    symbol: 'MOON',
    icon: '',
    status: 'voting',
    monetizationPolicy: 'cosmetic',
    vote: vote(),
    presale: null,
    ...over,
  };
}

describe('launchpadDiscoveryView', () => {
  it('maps a voting entry to a vote CTA with the quorum progress', () => {
    const [row] = launchpadDiscoveryView([entry()]);
    expect(row).toMatchObject({
      realmId: 1,
      realmName: 'Moonlight',
      symbol: 'MOON',
      status: 'voting',
      power: false,
      ctaKey: 'vote',
    });
    // 1M cast weight of a 2M quorum = 50% (same math as voteView.quorumPct).
    expect(row.progressPct).toBe(50);
  });

  it('maps a presale entry to a contribute CTA with the soft-cap progress', () => {
    const [row] = launchpadDiscoveryView([
      entry({ status: 'presale', vote: null, presale: presale() }),
    ]);
    expect(row.status).toBe('presale');
    expect(row.ctaKey).toBe('contribute');
    expect(row.progressPct).toBe(45); // floor(4500 / 100)
  });

  it('flags a power realm without changing the CTA', () => {
    const [row] = launchpadDiscoveryView([entry({ monetizationPolicy: 'power' })]);
    expect(row.power).toBe(true);
    expect(row.ctaKey).toBe('vote');
  });

  it('degrades to a 0% row rather than throwing when the matching payload is absent', () => {
    const [voting, inPresale] = launchpadDiscoveryView([
      entry({ status: 'voting', vote: null }),
      entry({ status: 'presale', vote: null, presale: null }),
    ]);
    expect(voting.progressPct).toBe(0);
    expect(inPresale.progressPct).toBe(0);
  });

  it('preserves row order and count across a mixed list', () => {
    const rows = launchpadDiscoveryView([
      entry({ realmId: 1, status: 'voting' }),
      entry({ realmId: 2, status: 'presale', vote: null, presale: presale() }),
      entry({ realmId: 3, status: 'voting' }),
    ]);
    expect(rows.map((r) => r.realmId)).toEqual([1, 2, 3]);
  });

  it('returns an empty list for an empty payload', () => {
    expect(launchpadDiscoveryView([])).toEqual([]);
  });
});
