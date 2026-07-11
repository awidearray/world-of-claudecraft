// Levy Street Fund portfolio panel (launchpad phase 6). A self-contained,
// host-injected panel that renders the PUBLIC, DISPLAY-ONLY holdings page from
// the /api/levy-fund payload. The pure render math lives in levy_fund_view.ts
// (Node-tested); this is the thin DOM consumer. There is deliberately no buy /
// sell / redeem control anywhere: the fund is a treasury we SHOW (PRD 8), and
// the display-only note says so at the top.

import type { Api } from '../net/online';
import { esc } from './esc';
import { formatNumber, t } from './i18n';
import { levyPortfolioView } from './levy_fund_view';

export interface LevyFundHost {
  api: Api;
  close(): void;
}

function usd(n: number | null): string {
  if (n === null) return '--';
  return `$${formatNumber(n, { maximumFractionDigits: n < 1 ? 6 : 2 })}`;
}

function shortMint(mint: string): string {
  return mint.length > 12 ? `${mint.slice(0, 4)}...${mint.slice(-4)}` : mint;
}

export class LevyFundPanel {
  private readonly root: HTMLElement;
  private readonly host: LevyFundHost;

  constructor(root: HTMLElement, host: LevyFundHost) {
    this.root = root;
    this.host = host;
  }

  async open(): Promise<void> {
    this.root.innerHTML = `<div class="levy-fund" role="region" aria-label="${esc(t('launchpad.levy.title'))}">
      <div class="levy-fund__head">
        <button type="button" class="levy-fund__back" data-levy-back>${esc(t('launchpad.back'))}</button>
        <h2>${esc(t('launchpad.levy.title'))}</h2>
      </div>
      <p class="levy-fund__sub">${esc(t('launchpad.levy.subtitle'))}</p>
      <p class="levy-fund__note">${esc(t('launchpad.levy.displayOnlyNote'))}</p>
      <div data-levy-body>${esc(t('launchpad.levy.loading'))}</div>
    </div>`;
    this.root.querySelector('[data-levy-back]')?.addEventListener('click', () => this.host.close());
    await this.refresh();
  }

  private async refresh(): Promise<void> {
    const body = this.root.querySelector('[data-levy-body]');
    if (!body) return;
    const model = levyPortfolioView(await this.host.api.levyFund());
    if (model.empty) {
      body.innerHTML = `<p class="levy-fund__empty">${esc(t('launchpad.levy.empty'))}</p>`;
      return;
    }
    const header = `<div class="levy-fund__aum">
      <div class="levy-fund__aum-value">${esc(usd(model.aumUsd))}</div>
      <div class="levy-fund__aum-label">${esc(t('launchpad.levy.aum'))}${
        model.aumSol !== null
          ? ` (${esc(formatNumber(model.aumSol, { maximumFractionDigits: 2 }))} ${esc(t('launchpad.levy.aumSol'))})`
          : ''
      }</div>
      <div class="levy-fund__meta">${esc(t('launchpad.levy.holdings', { count: String(model.holdingCount) }))}${
        model.excludedCount > 0
          ? ` &middot; ${esc(t('launchpad.levy.excluded', { count: String(model.excludedCount) }))}`
          : ''
      }${model.updatedAt ? ` &middot; ${esc(t('launchpad.levy.updated', { time: new Date(model.updatedAt).toLocaleString() }))}` : ''}</div>
      ${model.clamped ? `<div class="levy-fund__clamp">${esc(t('launchpad.levy.clamped'))}</div>` : ''}
    </div>`;

    const rows = model.rows
      .map((r) => {
        const tag = r.illiquid
          ? `<span class="levy-fund__illiquid" title="${esc(r.note ?? '')}">${esc(t('launchpad.levy.illiquidTag'))}</span>`
          : `<span class="levy-fund__src">${esc(r.source === 'dbc_curve' ? t('launchpad.levy.sourceCurve') : t('launchpad.levy.sourceDex'))}</span>`;
        return `<tr class="${r.illiquid ? 'levy-fund__row--illiquid' : ''}">
          <td><strong>${esc(r.symbol)}</strong> <span class="levy-fund__mint">${esc(shortMint(r.mint))}</span> ${tag}</td>
          <td>${esc(usd(r.priceUsd))}</td>
          <td>${esc(usd(r.valueUsd))}</td>
          <td>${r.illiquid ? '--' : `${esc(formatNumber(r.weightPct, { maximumFractionDigits: 1 }))}%`}</td>
        </tr>`;
      })
      .join('');

    body.innerHTML = `${header}
      <table class="levy-fund__table">
        <thead><tr>
          <th>${esc(t('launchpad.levy.colToken'))}</th>
          <th>${esc(t('launchpad.levy.colPrice'))}</th>
          <th>${esc(t('launchpad.levy.colValue'))}</th>
          <th>${esc(t('launchpad.levy.colWeight'))}</th>
        </tr></thead>
        <tbody>${rows}</tbody>
      </table>`;
  }
}
