// The public Levy Street Fund portfolio panel (launchpad phase 6): the
// daos.fun-style holdings view over the server's cached, display-only
// snapshot. Self-contained on the realm_operator.ts template: renders into a
// host container, reads only GET /api/levy-fund, and by design offers NO buy,
// sell, or redeem control of any kind (PRD section 8): the page exists to
// PROVE the platform's bag is locked beside every holder, not to trade it.

import type { Api } from '../net/online';
import { ApiError } from '../net/online';
import { esc } from './esc';
import { formatDateTime, formatNumber, t } from './i18n';
import { type FundHoldingRow, type FundViewModel, fundView } from './levy_fund_view';

export interface LevyFundHost {
  api: Api;
  close(): void;
}

function usd(value: number): string {
  return formatNumber(value, { maximumFractionDigits: 2, minimumFractionDigits: 2 });
}

export class LevyFundPanel {
  private readonly root: HTMLElement;
  private readonly host: LevyFundHost;

  constructor(root: HTMLElement, host: LevyFundHost) {
    this.root = root;
    this.host = host;
  }

  async open(): Promise<void> {
    this.root.innerHTML = `<p class="ro-hint">${esc(t('launchpad.fund.loading'))}</p>`;
    let view: FundViewModel | null = null;
    try {
      const data = (await this.host.api.levyFund()) as { fund: Parameters<typeof fundView>[0] };
      view = fundView(data.fund);
    } catch (err) {
      if (err instanceof ApiError && err.message === 'fund_not_published') {
        this.root.innerHTML = `<p class="ro-empty">${esc(t('launchpad.fund.notPublished'))}</p>`;
        this.wire();
        return;
      }
      this.root.innerHTML = `<p class="ro-hint ro-hint-muted">${esc(t('launchpad.err.generic'))}</p>`;
      this.wire();
      return;
    }
    this.render(view);
  }

  private render(v: FundViewModel): void {
    const sections: string[] = [];
    sections.push(`
      <section class="lf-head" aria-labelledby="lf-h">
        <h3 id="lf-h" class="ro-h">${esc(t('launchpad.fund.title'))}</h3>
        <p class="ro-sub">${esc(t('launchpad.fund.subtitle'))}</p>
        <p class="lf-aum">${esc(t('launchpad.fund.aum', { amount: usd(v.aumUsd) }))}</p>
        ${v.aumClamped ? `<p class="ro-hint ro-hint-muted">${esc(t('launchpad.fund.clampedNote'))}</p>` : ''}
        <p class="ro-hint ro-hint-muted">${esc(
          t('launchpad.fund.updated', { time: formatDateTime(new Date(v.updatedAt)) }),
        )}</p>
        <p class="ro-hint ro-hint-muted">${esc(t('launchpad.fund.policyNote'))}</p>
      </section>`);
    if (v.rows.length === 0) {
      sections.push(`<p class="ro-empty">${esc(t('launchpad.fund.empty'))}</p>`);
    } else {
      const rows = v.rows.map((row) => this.rowHtml(row)).join('');
      sections.push(`
        <div class="lf-table-wrap">
          <table class="lf-table" aria-label="${esc(t('launchpad.fund.tableAria'))}">
            <thead>
              <tr>
                <th scope="col">${esc(t('launchpad.fund.colToken'))}</th>
                <th scope="col">${esc(t('launchpad.fund.colAmount'))}</th>
                <th scope="col">${esc(t('launchpad.fund.colPrice'))}</th>
                <th scope="col">${esc(t('launchpad.fund.colValue'))}</th>
                <th scope="col">${esc(t('launchpad.fund.colWeight'))}</th>
                <th scope="col">${esc(t('launchpad.fund.colStatus'))}</th>
              </tr>
            </thead>
            <tbody>${rows}</tbody>
          </table>
        </div>`);
      if (v.illiquidCount > 0) {
        sections.push(
          `<p class="ro-hint ro-hint-muted">${esc(
            t('launchpad.fund.illiquidNote', { count: formatNumber(v.illiquidCount) }),
          )}</p>`,
        );
      }
    }
    sections.push(
      `<button id="lf-back" class="btn btn-secondary" type="button">${esc(t('launchpad.back'))}</button>`,
    );
    this.root.innerHTML = `<div class="ro lf">${sections.join('')}</div>`;
    this.wire();
  }

  private rowHtml(row: FundHoldingRow): string {
    const badges: string[] = [];
    if (row.locked) badges.push(t('launchpad.fund.badgeLocked'));
    if (row.graduated) badges.push(t('launchpad.fund.badgeGraduated'));
    const status = row.illiquid
      ? t('launchpad.fund.statusIlliquid')
      : t(`launchpad.fund.confidence.${row.confidence}`);
    const price = row.priceUsd === null ? '' : usd(row.priceUsd);
    const value = row.valueUsd === null ? '' : usd(row.valueUsd);
    const weight = row.illiquid ? '' : `${formatNumber(row.weightPct)}%`;
    return `
      <tr class="${row.illiquid ? 'lf-row lf-row-illiquid' : 'lf-row'}">
        <td>
          <a href="https://solscan.io/token/${esc(row.mint)}" target="_blank" rel="noopener noreferrer">${esc(row.symbol)}</a>
          ${badges.map((b) => `<span class="ro-badge">${esc(b)}</span>`).join(' ')}
        </td>
        <td>${esc(row.amountText)}</td>
        <td>${esc(price)}</td>
        <td>${esc(value)}</td>
        <td>${esc(weight)}</td>
        <td>${esc(status)}</td>
      </tr>`;
  }

  private wire(): void {
    this.root
      .querySelector<HTMLElement>('#lf-back')
      ?.addEventListener('click', () => this.host.close());
  }
}
