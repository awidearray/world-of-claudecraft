// Pure view-core for the public launch-discovery list (the community entry
// point into the realm token launchpad panel, PRD section 9): maps the
// GET /api/realms/launchpad payload to one render-model row per realm
// currently voting or in presale. DOM-free, i18n-free, Node-tested, and
// registered in UI_PURE_CORES (tests/architecture.test.ts). Reuses the exact
// vote/presale progress math from realm_launchpad_view.ts (voteView /
// presaleView) rather than re-deriving it, so the discovery list and the
// owner-facing panel can never disagree on a tally or a raise percent.

import { type PresaleWire, presaleView, type VoteWire, voteView } from './realm_launchpad_view';

export type DiscoveryStatus = 'voting' | 'presale';

export interface LaunchpadDiscoveryWire {
  realmId: number;
  realmName: string;
  symbol: string;
  icon: string;
  status: DiscoveryStatus;
  monetizationPolicy: 'cosmetic' | 'power';
  vote: VoteWire | null;
  presale: PresaleWire | null;
}

export interface DiscoveryRowModel {
  realmId: number;
  realmName: string;
  symbol: string;
  status: DiscoveryStatus;
  power: boolean;
  // 0..100: quorum progress while voting, combined soft-cap progress in presale.
  progressPct: number;
  ctaKey: 'vote' | 'contribute';
}

// Build one row per entry, newest-first order preserved from the wire (the
// server already sorts by updated_at desc). A malformed entry (status without
// its matching vote/presale payload, which the server never actually sends)
// degrades to a 0% row rather than throwing, so one bad row cannot blank the
// whole list.
export function launchpadDiscoveryView(
  entries: readonly LaunchpadDiscoveryWire[],
): DiscoveryRowModel[] {
  return entries.map((e) => {
    const power = e.monetizationPolicy === 'power';
    if (e.status === 'voting') {
      const progressPct = e.vote ? voteView(e.vote).quorumPct : 0;
      return {
        realmId: e.realmId,
        realmName: e.realmName,
        symbol: e.symbol,
        status: 'voting',
        power,
        progressPct,
        ctaKey: 'vote',
      };
    }
    const progressPct = e.presale ? presaleView(e.presale).progressPct : 0;
    return {
      realmId: e.realmId,
      realmName: e.realmName,
      symbol: e.symbol,
      status: 'presale',
      power,
      progressPct,
      ctaKey: 'contribute',
    };
  });
}
