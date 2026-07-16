// Public launch-discovery surface (launchpad phase 9, PRD section 9's
// "realm-list integration"). The launch vote and presale panels
// (src/ui/realm_launchpad.ts) were reachable only from the realm OWNER's
// operator dashboard; the REST routes (vote/presale read+cast+contribute)
// already serve any authenticated account with no owner check, so a
// community vote or a presale had no way for a non-owner player to even find
// the realm. This module lists every registered token currently in `voting`
// or `presale` status (any active realm), enriched with the SAME vote tally
// and presale progress the owner-facing panel already computes, so a
// non-owner can discover the realm and act on it.
//
// Pure orchestration, no SQL (RealmTokenDb.listByStatus owns the query);
// reuses voteStatus/presaleInfo verbatim rather than re-deriving the tally or
// progress math, so the discovery list and the owner panel can never drift.

import { type PresaleDeps, type PresaleInfo, presaleInfo } from './realm_presale';
import type { RealmToken, RealmTokenDb, RealmTokenStatus } from './realm_token';
import { type VoteDeps, type VoteStatus, voteStatus } from './realm_vote';

// The exact statuses the public discovery surface lists. Named (not inlined
// at the call site) so the filter is one obviously-correct constant a test
// can assert against, and so a later status (e.g. a curve `live` beacon)
// extends this list deliberately rather than by accident.
export const LAUNCHPAD_DISCOVERY_STATUSES: readonly RealmTokenStatus[] = ['voting', 'presale'];

export interface LaunchpadDiscoveryEntry {
  realmId: number;
  realmName: string;
  symbol: string;
  icon: string;
  status: RealmToken['status'];
  monetizationPolicy: RealmToken['monetizationPolicy'];
  vote: VoteStatus | null;
  presale: PresaleInfo | null;
}

export interface DiscoveryDeps {
  tokens: RealmTokenDb;
}

// List every voting/presale realm token for the public discovery surface,
// each carrying the same vote tally / presale progress the owner panel reads
// (accountId is passed through so a signed-in caller also sees their own
// vote/contribution, exactly like the owner-facing GET .../token endpoint).
export async function listLaunchpadDiscovery(
  deps: DiscoveryDeps & VoteDeps & PresaleDeps,
  accountId: number | null,
): Promise<LaunchpadDiscoveryEntry[]> {
  const rows = await deps.tokens.listByStatus(LAUNCHPAD_DISCOVERY_STATUSES);
  const entries: LaunchpadDiscoveryEntry[] = [];
  for (const row of rows) {
    const vote =
      row.status === 'voting' ? await voteStatus(deps, { realmId: row.realmId, accountId }) : null;
    const presale =
      row.status === 'presale'
        ? await presaleInfo(deps, { realmId: row.realmId, accountId })
        : null;
    entries.push({
      realmId: row.realmId,
      realmName: row.realmName,
      symbol: row.symbol,
      icon: row.icon,
      status: row.status,
      monetizationPolicy: row.monetizationPolicy,
      vote: vote?.ok ? vote.vote : null,
      presale: presale?.ok ? presale.presale : null,
    });
  }
  return entries;
}
