// Public launch-discovery panel (the community entry point into the realm
// token launchpad, PRD section 9): lists every realm currently voting on a
// token launch or running a presale, for ANY authenticated player, and opens
// the SAME realm_launchpad.ts panel already built for the owner dashboard on
// a row click. This module owns only the list; it never renders vote/presale
// controls itself (those stay inside RealmLaunchpad, which already gates
// founder-only sections on `page.isOwner`). The pure render math lives in
// realm_launches_view.ts (Node-tested); this is the thin DOM consumer.

import type { Api, LaunchpadDiscoveryEntry } from '../net/online';
import { esc } from './esc';
import { formatNumber, t } from './i18n';
import {
  type DiscoveryRowModel,
  type DiscoveryStatus,
  launchpadDiscoveryView,
} from './realm_launches_view';

// The server only ever emits `voting`/`presale` rows here (LAUNCHPAD_DISCOVERY_STATUSES
// in server/realm_launchpad_discovery.ts); narrow defensively so a wire status
// this client does not recognize is dropped rather than crashing the list.
function isDiscoveryStatus(status: LaunchpadDiscoveryEntry['status']): status is DiscoveryStatus {
  return status === 'voting' || status === 'presale';
}

export interface RealmLaunchesHost {
  api: Api;
  // Open the shared launchpad panel for a realm found here. Non-owner: the
  // panel shows vote/contribute controls, never the founder-only sections.
  openRealm(realm: { realmId: number; name: string }): void;
  close(): void;
}

export class RealmLaunches {
  private readonly root: HTMLElement;
  private readonly host: RealmLaunchesHost;

  constructor(root: HTMLElement, host: RealmLaunchesHost) {
    this.root = root;
    this.host = host;
  }

  async open(): Promise<void> {
    this.root.innerHTML = `<div class="rl" role="region" aria-label="${esc(t('launchpad.launches.title'))}">
      <div class="rl__head">
        <button type="button" class="rl__back" data-rl-back>${esc(t('launchpad.back'))}</button>
        <h2>${esc(t('launchpad.launches.title'))}</h2>
      </div>
      <p class="rl__sub">${esc(t('launchpad.launches.subtitle'))}</p>
      <div data-rl-body>${esc(t('launchpad.launches.loading'))}</div>
    </div>`;
    this.root.querySelector('[data-rl-back]')?.addEventListener('click', () => this.host.close());
    await this.refresh();
  }

  private async refresh(): Promise<void> {
    const body = this.root.querySelector('[data-rl-body]');
    if (!body) return;
    let rows: DiscoveryRowModel[];
    try {
      const entries = await this.host.api.launchpadDiscovery();
      rows = launchpadDiscoveryView(
        entries.filter((e): e is LaunchpadDiscoveryEntry & { status: DiscoveryStatus } =>
          isDiscoveryStatus(e.status),
        ),
      );
    } catch {
      body.innerHTML = `<p class="ro-hint ro-hint-muted">${esc(t('launchpad.err.generic'))}</p>`;
      return;
    }
    if (rows.length === 0) {
      body.innerHTML = `<p class="ro-empty">${esc(t('launchpad.launches.empty'))}</p>`;
      return;
    }
    body.innerHTML = `<div class="ro-mine-list">${rows.map((r) => this.rowHtml(r)).join('')}</div>`;
    for (const r of rows) {
      body
        .querySelector(`[data-rl-open="${r.realmId}"]`)
        ?.addEventListener('click', () =>
          this.host.openRealm({ realmId: r.realmId, name: r.realmName }),
        );
    }
  }

  private rowHtml(r: DiscoveryRowModel): string {
    const statusKey =
      r.status === 'voting'
        ? 'launchpad.launches.statusVoting'
        : 'launchpad.launches.statusPresale';
    const statusBadgeClass = r.status === 'voting' ? 'ro-badge-provisioning' : 'ro-badge-active';
    const progressKey =
      r.status === 'voting'
        ? 'launchpad.launches.progressVoting'
        : 'launchpad.launches.progressPresale';
    const ctaKey =
      r.ctaKey === 'vote' ? 'launchpad.launches.ctaVote' : 'launchpad.launches.ctaContribute';
    const powerTag = r.power
      ? `<span class="ro-badge">${esc(t('launchpad.launches.powerTag'))}</span>`
      : '';
    return `
      <div class="ro-realm rl-row">
        <div class="ro-realm-head">
          <span class="ro-realm-name">${esc(r.realmName)}</span>
          <span class="ro-badge">${esc(t('launchpad.symbolBadge', { symbol: r.symbol }))}</span>
          <span class="ro-badge ${statusBadgeClass}">${esc(t(statusKey))}</span>
          ${powerTag}
        </div>
        <div class="rl-progress" role="progressbar" aria-label="${esc(t(statusKey))}"
          aria-valuemin="0" aria-valuemax="100" aria-valuenow="${r.progressPct}">
          <div class="rl-progress-fill" style="width:${r.progressPct}%"></div>
        </div>
        <p class="ro-realm-meta">${esc(t(progressKey, { pct: formatNumber(r.progressPct) }))}</p>
        <div class="ro-realm-actions">
          <button type="button" class="btn btn-primary" data-rl-open="${r.realmId}">${esc(t(ctaKey))}</button>
        </div>
      </div>`;
  }
}
