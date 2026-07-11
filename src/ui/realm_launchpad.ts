// Realm token launchpad panel (phases 0 to 2): the token status page, the
// community launch vote, and the presale contribute flow. A self-contained
// module on the realm_operator.ts template: it renders into a host-provided
// container and reaches the chain/account only through an injected
// RealmLaunchpadHost, so it carries no wallet state of its own. The pure render
// math lives in realm_launchpad_view.ts (Node-tested); strings live in
// src/ui/i18n.catalog/launchpad.ts and server error CODES map to
// launchpad.err.* via ERR_KEYS below.

import type { Api, RealmPresaleQuote, RealmPresaleRail, RealmTokenPage } from '../net/online';
import { ApiError } from '../net/online';
import { esc } from './esc';
import type { TranslationKey } from './i18n';
import { formatNumber, t } from './i18n';
import {
  formatBaseAmount,
  launchpadChecklist,
  type PresaleViewModel,
  parseAmountToBase,
  presaleView,
  type VoteViewModel,
  voteView,
} from './realm_launchpad_view';

export interface RealmLaunchpadHost {
  api: Api;
  // The realm this panel operates on (picked from the operator dashboard).
  realm: { realmId: number; name: string };
  linkedWallet(): string | null;
  // Connect + verify a wallet matching the account link (same contract as the
  // realm operator host: null = cancelled, throws Error(localized) on failure).
  ensureWalletReady(): Promise<string | null>;
  // Sign + send the presale contribution. null = cancelled in the wallet.
  signContribution(quote: RealmPresaleQuote): Promise<string | null>;
  // Return to the operator dashboard.
  close(): void;
}

export const STATUS_KEYS: Record<string, TranslationKey> = {
  none: 'launchpad.status.none',
  prelaunch: 'launchpad.status.prelaunch',
  voting: 'launchpad.status.voting',
  presale: 'launchpad.status.presale',
  funded: 'launchpad.status.funded',
  refunding: 'launchpad.status.refunding',
  refunded: 'launchpad.status.refunded',
  live: 'launchpad.status.live',
  graduated: 'launchpad.status.graduated',
  closed: 'launchpad.status.closed',
};

const CHECKLIST_KEYS: Record<string, TranslationKey> = {
  register: 'launchpad.checklist.register',
  vote: 'launchpad.checklist.vote',
  presale: 'launchpad.checklist.presale',
  launch: 'launchpad.checklist.launch',
};

// Server `error` codes (plus the two literal route messages) -> launchpad.err.*
// keys. Exported so a unit test asserts every server-emitted code has a mapping.
export const ERR_KEYS = {
  not_realm_owner: 'launchpad.err.not_realm_owner',
  realm_not_found: 'launchpad.err.realm_not_found',
  realm_not_active: 'launchpad.err.realm_not_active',
  invalid_token_symbol: 'launchpad.err.invalid_token_symbol',
  invalid_token_icon: 'launchpad.err.invalid_token_icon',
  invalid_token_policy: 'launchpad.err.invalid_token_policy',
  token_already_registered: 'launchpad.err.token_already_registered',
  token_not_registered: 'launchpad.err.token_not_registered',
  vote_not_open: 'launchpad.err.vote_not_open',
  vote_not_openable: 'launchpad.err.vote_not_openable',
  invalid_vote_choice: 'launchpad.err.invalid_vote_choice',
  wallet_not_linked: 'launchpad.err.wallet_not_linked',
  vote_weight_unavailable: 'launchpad.err.vote_weight_unavailable',
  no_vote_weight: 'launchpad.err.no_vote_weight',
  already_voted: 'launchpad.err.already_voted',
  presale_not_open: 'launchpad.err.presale_not_open',
  presale_not_configured: 'launchpad.err.presale_not_configured',
  presale_already_configured: 'launchpad.err.presale_already_configured',
  presale_not_refunding: 'launchpad.err.presale_not_refunding',
  presale_unavailable: 'launchpad.err.presale_unavailable',
  invalid_escrow_wallet: 'launchpad.err.invalid_escrow_wallet',
  invalid_presale_caps: 'launchpad.err.invalid_presale_caps',
  invalid_currency: 'launchpad.err.invalid_currency',
  currency_not_enabled: 'launchpad.err.currency_not_enabled',
  invalid_amount: 'launchpad.err.invalid_amount',
  wallet_cap_exceeded: 'launchpad.err.wallet_cap_exceeded',
  raise_cap_exceeded: 'launchpad.err.raise_cap_exceeded',
  quote_not_found: 'launchpad.err.quote_not_found',
  not_your_quote: 'launchpad.err.not_your_quote',
  quote_expired: 'launchpad.err.quote_expired',
  contribution_already_recorded: 'launchpad.err.contribution_already_recorded',
  contribution_not_found: 'launchpad.err.contribution_not_found',
  already_refunded: 'launchpad.err.already_refunded',
  refund_sig_reused: 'launchpad.err.refund_sig_reused',
  wrong_refunder: 'launchpad.err.wrong_refunder',
  refund_short: 'launchpad.err.refund_short',
  bad_signature: 'launchpad.err.bad_signature',
  not_finalized: 'launchpad.err.not_finalized',
  tx_failed: 'launchpad.err.tx_failed',
  token_2022: 'launchpad.err.token_2022',
  memo_mismatch: 'launchpad.err.memo_mismatch',
  wrong_payer: 'launchpad.err.wrong_payer',
  escrow_short: 'launchpad.err.escrow_short',
  missing_quoteId_or_paySig: 'launchpad.err.missing_quoteId_or_paySig',
  missing_payTxSig_or_refundSig: 'launchpad.err.missing_payTxSig_or_refundSig',
  // Phase 3 launch flow (mint factory + allocation locks).
  mint_not_ready: 'launchpad.err.mint_not_ready',
  token_already_minted: 'launchpad.err.token_already_minted',
  token_not_minted: 'launchpad.err.token_not_minted',
  levy_wallet_unconfigured: 'launchpad.err.levy_wallet_unconfigured',
  launch_unavailable: 'launchpad.err.launch_unavailable',
  launch_sig_reused: 'launchpad.err.launch_sig_reused',
  mint_mismatch: 'launchpad.err.mint_mismatch',
  already_distributed: 'launchpad.err.already_distributed',
  not_distributed: 'launchpad.err.not_distributed',
  distribution_mismatch: 'launchpad.err.distribution_mismatch',
  invalid_lock_bucket: 'launchpad.err.invalid_lock_bucket',
  already_locked: 'launchpad.err.already_locked',
  lock_mismatch: 'launchpad.err.lock_mismatch',
  lock_not_immutable: 'launchpad.err.lock_not_immutable',
  lock_underfunded: 'launchpad.err.lock_underfunded',
  locks_incomplete: 'launchpad.err.locks_incomplete',
  missing_quoteId_or_signature: 'launchpad.err.missing_quoteId_or_signature',
  // Phase 4 bonding-curve launch.
  curve_disabled: 'launchpad.err.curve_disabled',
  fee_claimer_unconfigured: 'launchpad.err.fee_claimer_unconfigured',
  curve_already_launched: 'launchpad.err.curve_already_launched',
  curve_not_launched: 'launchpad.err.curve_not_launched',
  curve_mismatch: 'launchpad.err.curve_mismatch',
  not_migrated: 'launchpad.err.not_migrated',
  // Phase 7 power-realm token-to-copper credit.
  power_credit_disabled: 'launchpad.err.power_credit_disabled',
  power_sink_unconfigured: 'launchpad.err.power_sink_unconfigured',
  not_power_realm: 'launchpad.err.not_power_realm',
  token_2022_mismatch: 'launchpad.err.token_2022_mismatch',
  sink_not_credited: 'launchpad.err.sink_not_credited',
  amount_too_small: 'launchpad.err.amount_too_small',
  credit_already_recorded: 'launchpad.err.credit_already_recorded',
  no_character_to_credit: 'launchpad.err.no_character_to_credit',
  missing_payTxSig: 'launchpad.err.missing_payTxSig',
  'too many requests, slow down': 'launchpad.err.rate_limited',
} satisfies Record<string, TranslationKey>;

export function messageForError(err: unknown): string {
  if (err instanceof ApiError) {
    const key = (ERR_KEYS as Record<string, TranslationKey>)[err.message];
    return key ? t(key) : t('launchpad.err.generic');
  }
  if (err instanceof Error && err.message === 'wallet_mismatch')
    return t('launchpad.err.wallet_mismatch');
  if (err instanceof Error && err.message) return err.message;
  return t('launchpad.err.generic');
}

// Whole-$WOC display for vote weights (locale-grouped; whale weights fit).
function wocAmount(weight: bigint): string {
  return formatNumber(Number(weight));
}

export class RealmLaunchpad {
  private readonly root: HTMLElement;
  private readonly host: RealmLaunchpadHost;
  private page: RealmTokenPage | null = null;
  private busy = false;
  private selectedCurrency: RealmPresaleRail['currency'] | null = null;

  constructor(root: HTMLElement, host: RealmLaunchpadHost) {
    this.root = root;
    this.host = host;
  }

  async open(): Promise<void> {
    this.page = null;
    this.busy = false;
    this.root.innerHTML = `<p class="ro-hint">${esc(t('launchpad.loading'))}</p>`;
    await this.reload();
  }

  private async reload(): Promise<void> {
    try {
      this.page = await this.host.api.realmToken(this.host.realm.realmId);
    } catch (err) {
      this.root.innerHTML = `<p class="ro-hint ro-hint-muted">${esc(messageForError(err))}</p>`;
      return;
    }
    this.render();
  }

  // ── Render ─────────────────────────────────────────────────────────────────

  private render(): void {
    const page = this.page;
    if (!page) return;
    const status = page.token?.status ?? 'none';
    const sections: string[] = [];
    sections.push(this.headerHtml(status));
    if (page.token?.monetizationPolicy === 'power') {
      sections.push(
        `<p class="ro-hint lp-power-banner" role="note">${esc(t('launchpad.policy.powerBanner'))}</p>`,
      );
    }
    if (!page.token) {
      sections.push(
        page.isOwner
          ? this.registerHtml()
          : `<p class="ro-empty">${esc(t('launchpad.status.none'))}</p>`,
      );
    } else {
      if (page.vote) sections.push(this.voteHtml(voteView(page.vote), status));
      if (page.presale) sections.push(this.presaleHtml(presaleView(page.presale)));
    }
    sections.push(
      `<button id="lp-back" class="btn btn-secondary" type="button">${esc(t('launchpad.back'))}</button>`,
    );
    sections.push(`<p id="lp-status" class="ro-status" role="status" aria-live="polite"></p>`);
    this.root.innerHTML = `<div class="ro lp">${sections.join('')}</div>`;
    this.wire();
  }

  private headerHtml(status: string): string {
    const page = this.page;
    const badge = STATUS_KEYS[status] ?? 'launchpad.status.none';
    const steps = launchpadChecklist(status as Parameters<typeof launchpadChecklist>[0])
      .map((item) => {
        const cls = item.done
          ? 'lp-step lp-step-done'
          : item.current
            ? 'lp-step lp-step-current'
            : 'lp-step';
        return `<li class="${cls}">${esc(t(CHECKLIST_KEYS[item.step]))}</li>`;
      })
      .join('');
    const symbol = page?.token
      ? `<span class="ro-badge">${esc(t('launchpad.symbolBadge', { symbol: page.token.symbol }))}</span>`
      : '';
    return `
      <section class="lp-head" aria-labelledby="lp-h">
        <h3 id="lp-h" class="ro-h">${esc(t('launchpad.title'))}</h3>
        <div class="ro-realm-head">
          <span class="ro-realm-name">${esc(this.host.realm.name)}</span>
          ${symbol}
          <span class="ro-badge">${esc(t(badge))}</span>
        </div>
        <ol class="lp-checklist" aria-label="${esc(t('launchpad.checklist.aria'))}">${steps}</ol>
      </section>`;
  }

  private registerHtml(): string {
    return `
      <section class="lp-register" aria-labelledby="lp-reg-h">
        <h4 id="lp-reg-h" class="ro-h">${esc(t('launchpad.register.title'))}</h4>
        <p class="ro-sub">${esc(t('launchpad.register.subtitle'))}</p>
        <div class="ro-field">
          <label class="ro-label" for="lp-symbol">${esc(t('launchpad.register.symbolLabel'))}</label>
          <input id="lp-symbol" class="ro-input" type="text" maxlength="10" autocomplete="off"
            spellcheck="false" placeholder="${esc(t('launchpad.register.symbolPlaceholder'))}" />
        </div>
        <div class="ro-field">
          <label class="ro-label" for="lp-policy">${esc(t('launchpad.register.policyLabel'))}</label>
          <select id="lp-policy" class="ro-input ro-select">
            <option value="cosmetic">${esc(t('launchpad.policy.cosmetic'))}</option>
            <option value="power">${esc(t('launchpad.policy.power'))}</option>
          </select>
          <p class="ro-hint ro-hint-muted">${esc(t('launchpad.register.policyHint'))}</p>
        </div>
        <button id="lp-register" class="btn btn-primary" type="button">${esc(t('launchpad.register.submit'))}</button>
      </section>`;
  }

  private voteHtml(v: VoteViewModel, status: string): string {
    const page = this.page;
    const lines: string[] = [];
    lines.push(`<h4 class="ro-h">${esc(t('launchpad.vote.title'))}</h4>`);
    lines.push(`<p class="ro-sub">${esc(t('launchpad.vote.subtitle'))}</p>`);
    if (status === 'prelaunch') {
      if (page?.isOwner) {
        lines.push(
          `<button id="lp-vote-open" class="btn btn-primary" type="button">${esc(t('launchpad.vote.openBtn'))}</button>`,
        );
      }
    } else {
      lines.push(`
        <div class="lp-bar" role="progressbar" aria-label="${esc(t('launchpad.vote.tallyAria'))}"
          aria-valuemin="0" aria-valuemax="100" aria-valuenow="${v.yesSharePct}">
          <div class="lp-bar-fill" style="width:${v.yesSharePct}%"></div>
        </div>
        <p class="ro-hint">${esc(t('launchpad.vote.tallyYes', { amount: wocAmount(v.yesWeight) }))}
          &middot; ${esc(t('launchpad.vote.tallyNo', { amount: wocAmount(v.noWeight) }))}</p>
        <div class="lp-bar lp-bar-quorum" role="progressbar" aria-label="${esc(t('launchpad.vote.quorumAria'))}"
          aria-valuemin="0" aria-valuemax="100" aria-valuenow="${v.quorumPct}">
          <div class="lp-bar-fill" style="width:${v.quorumPct}%"></div>
        </div>
        <p class="ro-hint ro-hint-muted">${esc(t('launchpad.vote.quorum', { current: wocAmount(v.totalWeight), required: wocAmount(v.quorum) }))}</p>
        <p class="ro-hint ro-hint-muted">${esc(t('launchpad.vote.threshold', { pct: formatNumber(v.thresholdPct) }))}</p>`);
      const outcomeKey: TranslationKey =
        v.outcome === 'passed'
          ? 'launchpad.vote.outcomePassed'
          : v.outcome === 'failed'
            ? 'launchpad.vote.outcomeFailed'
            : 'launchpad.vote.outcomePending';
      lines.push(`<p class="ro-hint">${esc(t(outcomeKey))}</p>`);
      if (v.canVote) {
        lines.push(`
          <div class="ro-realm-actions">
            <button id="lp-vote-yes" class="btn btn-primary" type="button">${esc(t('launchpad.vote.yes'))}</button>
            <button id="lp-vote-no" class="btn btn-secondary" type="button">${esc(t('launchpad.vote.no'))}</button>
          </div>`);
      } else if (v.myWeight !== null) {
        lines.push(
          `<p class="ro-hint">${esc(t('launchpad.vote.yourVote', { amount: wocAmount(v.myWeight) }))}</p>`,
        );
      }
    }
    return `<section class="lp-vote" aria-label="${esc(t('launchpad.status.voting'))}">${lines.join('')}</section>`;
  }

  private presaleHtml(p: PresaleViewModel): string {
    const page = this.page;
    const relevant = p.configured || p.open || p.refunding || page?.token?.status === 'funded';
    if (!relevant) return '';
    const lines: string[] = [];
    lines.push(`<h4 class="ro-h">${esc(t('launchpad.presale.title'))}</h4>`);
    if (!p.configured) {
      if (p.open && page?.isOwner) {
        lines.push(this.presaleConfigHtml());
      } else {
        lines.push(
          `<p class="ro-hint ro-hint-muted">${esc(t('launchpad.presale.notConfigured'))}</p>`,
        );
      }
      return `<section class="lp-presale">${lines.join('')}</section>`;
    }
    lines.push(`<p class="ro-sub">${esc(t('launchpad.presale.subtitle'))}</p>`);
    lines.push(
      `<p class="ro-hint ro-hint-muted">${esc(t('launchpad.presale.stripeDeferred'))}</p>`,
    );
    lines.push(`
      <div class="lp-bar" role="progressbar" aria-label="${esc(t('launchpad.presale.progressAria'))}"
        aria-valuemin="0" aria-valuemax="100" aria-valuenow="${p.progressPct}">
        <div class="lp-bar-fill" style="width:${p.progressPct}%"></div>
      </div>
      <p class="ro-hint">${esc(t('launchpad.presale.progress', { pct: formatNumber(p.progressPct) }))}</p>`);
    if (p.softCapMet)
      lines.push(`<p class="ro-hint">${esc(t('launchpad.presale.softCapMet'))}</p>`);
    for (const rail of p.rails) {
      lines.push(`
        <p class="ro-hint">${esc(
          t('launchpad.presale.railRaised', {
            raised: formatBaseAmount(rail.raisedBase, rail.decimals),
            cap: formatBaseAmount(rail.softCapBase, rail.decimals),
            currency: rail.currency,
          }),
        )}</p>`);
    }
    if (p.escrowWallet) {
      lines.push(
        `<p class="ro-hint ro-hint-muted lp-escrow">${esc(t('launchpad.presale.escrowNote', { address: p.escrowWallet }))}</p>`,
      );
    }
    lines.push(`<p class="ro-hint ro-hint-muted">${esc(t('launchpad.presale.refundTerms'))}</p>`);
    if (p.open) {
      lines.push(this.contributeHtml(p));
      if (page?.isOwner) {
        lines.push(`
          <button id="lp-finalize" class="btn btn-secondary" type="button">${esc(t('launchpad.presale.finalize'))}</button>
          <p class="ro-hint ro-hint-muted">${esc(t('launchpad.presale.finalizeHint'))}</p>`);
      }
    }
    if (p.refunding) {
      lines.push(`
        <h4 class="ro-h">${esc(t('launchpad.presale.refundTitle'))}</h4>
        <p class="ro-hint">${esc(t('launchpad.presale.refundNote'))}</p>
        <p class="ro-hint">${esc(
          p.unrefundedCount === 0
            ? t('launchpad.presale.refundDone')
            : t('launchpad.presale.refundRemaining', { count: formatNumber(p.unrefundedCount) }),
        )}</p>`);
    }
    return `<section class="lp-presale">${lines.join('')}</section>`;
  }

  private contributeHtml(p: PresaleViewModel): string {
    const rails = p.rails.filter((r) => r.contributable);
    if (rails.length === 0)
      return `<p class="ro-hint ro-hint-muted">${esc(t('launchpad.presale.railFull'))}</p>`;
    const selected =
      this.selectedCurrency && rails.some((r) => r.currency === this.selectedCurrency)
        ? this.selectedCurrency
        : rails[0].currency;
    this.selectedCurrency = selected;
    const rail = rails.find((r) => r.currency === selected)!;
    const options = rails
      .map(
        (r) =>
          `<option value="${esc(r.currency)}"${r.currency === selected ? ' selected' : ''}>${esc(r.currency)}</option>`,
      )
      .join('');
    const submitKey: TranslationKey = this.host.linkedWallet()
      ? 'launchpad.presale.contribute'
      : 'launchpad.presale.contributeConnect';
    return `
      <div class="ro-field">
        <label class="ro-label" for="lp-amount">${esc(t('launchpad.presale.amountLabel', { currency: selected }))}</label>
        <div class="lp-contribute-row">
          <select id="lp-currency" class="ro-input ro-select" aria-label="${esc(t('launchpad.presale.amountLabel', { currency: selected }))}">${options}</select>
          <input id="lp-amount" class="ro-input" type="text" inputmode="decimal" autocomplete="off"
            placeholder="${esc(t('launchpad.presale.amountPlaceholder'))}" />
        </div>
        <p class="ro-hint ro-hint-muted">${esc(
          t('launchpad.presale.railWalletRemaining', {
            amount: formatBaseAmount(rail.myRemainingBase, rail.decimals),
            currency: selected,
          }),
        )}</p>
      </div>
      <button id="lp-contribute" class="btn btn-primary" type="button">${esc(t(submitKey))}</button>`;
  }

  private presaleConfigHtml(): string {
    const railFields = (['SOL', 'USDC', 'WOC'] as const)
      .map(
        (c) => `
        <div class="ro-field lp-config-rail">
          <label class="ro-label" for="lp-soft-${c}">${esc(t('launchpad.presale.config.softLabel', { currency: c }))}</label>
          <input id="lp-soft-${c}" class="ro-input" type="text" inputmode="numeric" autocomplete="off" />
          <label class="ro-label" for="lp-raise-${c}">${esc(t('launchpad.presale.config.raiseLabel', { currency: c }))}</label>
          <input id="lp-raise-${c}" class="ro-input" type="text" inputmode="numeric" autocomplete="off" />
          <label class="ro-label" for="lp-wcap-${c}">${esc(t('launchpad.presale.config.walletLabel', { currency: c }))}</label>
          <input id="lp-wcap-${c}" class="ro-input" type="text" inputmode="numeric" autocomplete="off" />
        </div>`,
      )
      .join('');
    return `
      <div class="lp-config">
        <h5 class="ro-h">${esc(t('launchpad.presale.config.title'))}</h5>
        <p class="ro-sub">${esc(t('launchpad.presale.config.subtitle'))}</p>
        <div class="ro-field">
          <label class="ro-label" for="lp-escrow">${esc(t('launchpad.presale.config.escrowLabel'))}</label>
          <input id="lp-escrow" class="ro-input" type="text" autocomplete="off" spellcheck="false" />
        </div>
        ${railFields}
        <button id="lp-config-submit" class="btn btn-primary" type="button">${esc(t('launchpad.presale.config.submit'))}</button>
      </div>`;
  }

  // ── Wiring + flows ─────────────────────────────────────────────────────────

  private wire(): void {
    this.on('#lp-back', () => this.host.close());
    this.on('#lp-register', () => void this.register());
    this.on('#lp-vote-open', () => void this.openVoteFlow());
    this.on('#lp-vote-yes', () => void this.castVoteFlow('yes'));
    this.on('#lp-vote-no', () => void this.castVoteFlow('no'));
    this.on('#lp-config-submit', () => void this.configureFlow());
    this.on('#lp-contribute', () => void this.contributeFlow());
    this.on('#lp-finalize', () => void this.finalizeFlow());
    const currency = this.root.querySelector<HTMLSelectElement>('#lp-currency');
    currency?.addEventListener('change', () => {
      this.selectedCurrency = currency.value as RealmPresaleRail['currency'];
      this.render();
    });
  }

  private on(sel: string, fn: () => void): void {
    this.root.querySelector<HTMLElement>(sel)?.addEventListener('click', fn);
  }

  private setStatus(text: string, kind: 'info' | 'error' | 'success'): void {
    const el = this.root.querySelector<HTMLElement>('#lp-status');
    if (!el) return;
    el.textContent = text;
    el.className = `ro-status ro-status-${kind}`;
  }

  private async run(flow: () => Promise<void>): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    try {
      await flow();
    } catch (err) {
      this.setStatus(messageForError(err), 'error');
    } finally {
      this.busy = false;
    }
  }

  private async register(): Promise<void> {
    const symbol = this.root.querySelector<HTMLInputElement>('#lp-symbol')?.value.trim() ?? '';
    const policy = (this.root.querySelector<HTMLSelectElement>('#lp-policy')?.value ??
      'cosmetic') as 'cosmetic' | 'power';
    if (!symbol) return;
    await this.run(async () => {
      this.setStatus(t('launchpad.flow.registering'), 'info');
      await this.host.api.registerRealmToken(this.host.realm.realmId, symbol, policy);
      await this.reload();
    });
  }

  private async openVoteFlow(): Promise<void> {
    await this.run(async () => {
      this.setStatus(t('launchpad.flow.openingVote'), 'info');
      await this.host.api.openRealmTokenVote(this.host.realm.realmId);
      await this.reload();
    });
  }

  private async castVoteFlow(choice: 'yes' | 'no'): Promise<void> {
    await this.run(async () => {
      const wallet = await this.host.ensureWalletReady();
      if (!wallet) return;
      this.setStatus(t('launchpad.flow.castingVote'), 'info');
      await this.host.api.castRealmVote(this.host.realm.realmId, choice);
      await this.reload();
    });
  }

  private async configureFlow(): Promise<void> {
    const escrow = this.root.querySelector<HTMLInputElement>('#lp-escrow')?.value.trim() ?? '';
    const decimals: Record<'SOL' | 'USDC' | 'WOC', number> = { SOL: 9, USDC: 6, WOC: 6 };
    const rails: Record<
      string,
      { softCapBase: string; raiseCapBase: string; walletCapBase: string }
    > = {};
    for (const c of ['SOL', 'USDC', 'WOC'] as const) {
      const read = (id: string) =>
        this.root.querySelector<HTMLInputElement>(id)?.value.trim() ?? '';
      const soft = read(`#lp-soft-${c}`);
      const raise = read(`#lp-raise-${c}`);
      const wcap = read(`#lp-wcap-${c}`);
      if (!soft && !raise && !wcap) continue; // rail disabled
      const dec = decimals[c];
      const softBase = parseAmountToBase(soft, dec);
      const raiseBase = parseAmountToBase(raise, dec);
      const wcapBase = parseAmountToBase(wcap, dec);
      if (!softBase || !raiseBase || !wcapBase) {
        this.setStatus(t('launchpad.err.invalid_presale_caps'), 'error');
        return;
      }
      rails[c] = {
        softCapBase: softBase.toString(),
        raiseCapBase: raiseBase.toString(),
        walletCapBase: wcapBase.toString(),
      };
    }
    await this.run(async () => {
      this.setStatus(t('launchpad.flow.configuring'), 'info');
      await this.host.api.configureRealmPresale(this.host.realm.realmId, escrow, rails);
      await this.reload();
    });
  }

  private async contributeFlow(): Promise<void> {
    const page = this.page;
    if (!page?.presale) return;
    const p = presaleView(page.presale);
    const currency = this.selectedCurrency;
    const rail = p.rails.find((r) => r.currency === currency);
    const raw = this.root.querySelector<HTMLInputElement>('#lp-amount')?.value ?? '';
    if (!rail) return;
    const amountBase = parseAmountToBase(raw, rail.decimals);
    if (!amountBase) {
      this.setStatus(t('launchpad.err.invalid_amount'), 'error');
      return;
    }
    await this.run(async () => {
      const wallet = await this.host.ensureWalletReady();
      if (!wallet) return;
      this.setStatus(t('launchpad.flow.quoting'), 'info');
      const quote = await this.host.api.quoteRealmPresale(
        this.host.realm.realmId,
        rail.currency,
        amountBase.toString(),
      );
      this.setStatus(t('launchpad.flow.paying'), 'info');
      const paySig = await this.host.signContribution(quote);
      if (!paySig) return; // cancelled in the wallet
      this.setStatus(t('launchpad.flow.confirming'), 'info');
      await this.host.api.confirmRealmPresale(this.host.realm.realmId, quote.quoteId, paySig);
      await this.reload();
      this.setStatus(t('launchpad.flow.contributed'), 'success');
    });
  }

  private async finalizeFlow(): Promise<void> {
    await this.run(async () => {
      this.setStatus(t('launchpad.flow.finalizing'), 'info');
      await this.host.api.finalizeRealmPresale(this.host.realm.realmId);
      await this.reload();
    });
  }
}
