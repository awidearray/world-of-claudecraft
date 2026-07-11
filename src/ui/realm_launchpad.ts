// Realm token launchpad panel (phases 0 to 2): the token status page, the
// community launch vote, and the presale contribute flow. A self-contained
// module on the realm_operator.ts template: it renders into a host-provided
// container and reaches the chain/account only through an injected
// RealmLaunchpadHost, so it carries no wallet state of its own. The pure render
// math lives in realm_launchpad_view.ts (Node-tested); strings live in
// src/ui/i18n.catalog/launchpad.ts and server error CODES map to
// launchpad.err.* via ERR_KEYS below.

import type {
  Api,
  CharacterSummary,
  RealmCurveInfo,
  RealmLaunchCheck,
  RealmLaunchStatus,
  RealmPowerQuote,
  RealmPresaleQuote,
  RealmPresaleRail,
  RealmTokenPage,
} from '../net/online';
import { ApiError } from '../net/online';
import { esc } from './esc';
import type { TranslationKey } from './i18n';
import { formatNumber, t } from './i18n';
import {
  bpsPercent,
  type CurveViewModel,
  curveView,
  formatBaseAmount,
  type LaunchViewModel,
  launchpadChecklist,
  launchView,
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
  // Co-sign + send a server-built partial-signed transaction (the phase 3
  // create-mint tx). null = cancelled in the wallet.
  signServerTransaction(txBase64: string): Promise<string | null>;
  // Sign + send the phase 7 token-to-copper payment (one Token-2022 transfer
  // into the realm treasury sink). null = cancelled in the wallet.
  signPowerCredit(quote: RealmPowerQuote): Promise<string | null>;
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

const LAUNCH_STEP_KEYS: Record<string, TranslationKey> = {
  mint: 'launchpad.launch.step.mint',
  locks: 'launchpad.launch.step.locks',
  verify: 'launchpad.launch.step.verify',
  list: 'launchpad.launch.step.list',
};

const BUCKET_KEYS: Record<string, TranslationKey> = {
  founder: 'launchpad.launch.bucket.founder',
  levy: 'launchpad.launch.bucket.levy',
  treasury: 'launchpad.launch.bucket.treasury',
};

// Verification check ids (server/realm_token_mint.ts) -> localized labels. The
// bucket prefix (founder_/levy_/treasury_) is stripped and rendered separately.
const CHECK_KEYS: Record<string, TranslationKey> = {
  mint_found: 'launchpad.launch.check.mint_found',
  mint_profile: 'launchpad.launch.check.mint_profile',
  supply_exact: 'launchpad.launch.check.supply_exact',
  mint_authority_renounced: 'launchpad.launch.check.mint_authority_renounced',
  lock_found: 'launchpad.launch.check.lock_found',
  lock_mint: 'launchpad.launch.check.lock_mint',
  lock_recipient: 'launchpad.launch.check.lock_recipient',
  lock_immutable: 'launchpad.launch.check.lock_immutable',
  lock_token_program: 'launchpad.launch.check.lock_token_program',
  lock_untouched: 'launchpad.launch.check.lock_untouched',
  lock_amount: 'launchpad.launch.check.lock_amount',
  lock_schedule: 'launchpad.launch.check.lock_schedule',
  lock_funded: 'launchpad.launch.check.lock_funded',
};

// Split a check id into its bucket prefix (if any) + base label key.
export function checkLabel(check: string): { bucket: string | null; key: TranslationKey } {
  const m = /^(founder|levy|treasury)_(.+)$/.exec(check);
  const base = m ? m[2] : check;
  const key = CHECK_KEYS[base] ?? 'launchpad.launch.check.unknown';
  return { bucket: m ? m[1] : null, key };
}

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
  // launch (phase 3): mint factory + lock verification
  mint_already_created: 'launchpad.err.mint_already_created',
  presale_not_funded: 'launchpad.err.presale_not_funded',
  levy_fund_unconfigured: 'launchpad.err.levy_fund_unconfigured',
  invalid_treasury_wallet: 'launchpad.err.invalid_treasury_wallet',
  invalid_token_name: 'launchpad.err.invalid_token_name',
  invalid_token_uri: 'launchpad.err.invalid_token_uri',
  chain_unavailable: 'launchpad.err.chain_unavailable',
  launch_not_prepared: 'launchpad.err.launch_not_prepared',
  mint_not_in_tx: 'launchpad.err.mint_not_in_tx',
  mint_not_found: 'launchpad.err.mint_not_found',
  wrong_token_program: 'launchpad.err.wrong_token_program',
  wrong_decimals: 'launchpad.err.wrong_decimals',
  freeze_authority_set: 'launchpad.err.freeze_authority_set',
  bad_metadata_pointer: 'launchpad.err.bad_metadata_pointer',
  metadata_symbol_mismatch: 'launchpad.err.metadata_symbol_mismatch',
  unexpected_extension: 'launchpad.err.unexpected_extension',
  launch_sig_replayed: 'launchpad.err.launch_sig_replayed',
  mint_not_created: 'launchpad.err.mint_not_created',
  invalid_lock_address: 'launchpad.err.invalid_lock_address',
  launch_not_verifiable: 'launchpad.err.launch_not_verifiable',
  locks_not_verified: 'launchpad.err.locks_not_verified',
  not_listable: 'launchpad.err.not_listable',
  missing_sig: 'launchpad.err.missing_sig',
  // curve (phase 4): bonding-curve listing + graduation
  launchpad_disabled: 'launchpad.err.launchpad_disabled',
  launchpad_config_unreadable: 'launchpad.err.launchpad_config_unreadable',
  curve_already_created: 'launchpad.err.curve_already_created',
  host_requires_dbc_mint: 'launchpad.err.host_requires_dbc_mint',
  invalid_base_mint: 'launchpad.err.invalid_base_mint',
  curve_not_found: 'launchpad.err.curve_not_found',
  wrong_curve_creator: 'launchpad.err.wrong_curve_creator',
  not_live: 'launchpad.err.not_live',
  not_migrated: 'launchpad.err.not_migrated',
  graduation_not_found: 'launchpad.err.graduation_not_found',
  lp_not_permanently_locked: 'launchpad.err.lp_not_permanently_locked',
  not_damm_v2: 'launchpad.err.not_damm_v2',
  no_locked_vesting: 'launchpad.err.no_locked_vesting',
  no_migration_threshold: 'launchpad.err.no_migration_threshold',
  // power (phase 7): token-to-copper conversion on power realms
  power_disabled: 'launchpad.err.power_disabled',
  realm_not_power: 'launchpad.err.realm_not_power',
  token_not_live: 'launchpad.err.token_not_live',
  power_rate_unset: 'launchpad.err.power_rate_unset',
  power_sink_unavailable: 'launchpad.err.power_sink_unavailable',
  amount_below_minimum: 'launchpad.err.amount_below_minimum',
  character_not_found: 'launchpad.err.character_not_found',
  sink_short: 'launchpad.err.sink_short',
  credit_already_recorded: 'launchpad.err.credit_already_recorded',
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
  private launch: RealmLaunchStatus | null = null;
  private lastChecks: RealmLaunchCheck[] | null = null;
  private curve: RealmCurveInfo | null = null;
  // The account's characters on this realm (the power-convert delivery picker;
  // loaded only when the realm converts, i.e. policy `power` + a live token).
  private characters: CharacterSummary[] | null = null;
  // The DBC base mint returned by curve/prepare, held until the founder's
  // creation transaction finalizes and .../curve/confirm verifies it.
  private pendingCurveMint: string | null = null;
  private busy = false;
  private selectedCurrency: RealmPresaleRail['currency'] | null = null;

  constructor(root: HTMLElement, host: RealmLaunchpadHost) {
    this.root = root;
    this.host = host;
  }

  async open(): Promise<void> {
    this.page = null;
    this.launch = null;
    this.lastChecks = null;
    this.busy = false;
    this.root.innerHTML = `<p class="ro-hint">${esc(t('launchpad.loading'))}</p>`;
    await this.reload();
  }

  private async reload(): Promise<void> {
    try {
      this.page = await this.host.api.realmToken(this.host.realm.realmId);
      const status = this.page.token?.status;
      const launchable = status === 'funded' || status === 'live' || status === 'graduated';
      this.launch = launchable ? await this.host.api.realmLaunch(this.host.realm.realmId) : null;
      this.curve = launchable ? await this.fetchCurve() : null;
      const converts =
        this.page.token?.monetizationPolicy === 'power' &&
        (status === 'live' || status === 'graduated');
      this.characters = converts ? await this.host.api.characters() : null;
    } catch (err) {
      this.root.innerHTML = `<p class="ro-hint ro-hint-muted">${esc(messageForError(err))}</p>`;
      return;
    }
    this.render();
  }

  // The curve surface is flag-gated server-side (mainnet dry-run sign-off);
  // a disabled host is an expected state the panel renders without, never an
  // error that hides the rest of the page.
  private async fetchCurve(): Promise<RealmCurveInfo | null> {
    try {
      return await this.host.api.realmCurve(this.host.realm.realmId);
    } catch (err) {
      if (err instanceof ApiError && err.message === 'launchpad_disabled') return null;
      throw err;
    }
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
      if (this.launch) {
        sections.push(
          this.launchHtml(launchView(this.launch, status as Parameters<typeof launchView>[1])),
        );
      }
      if (this.curve) sections.push(this.curveHtml(curveView(this.curve), status));
      if (this.characters) sections.push(this.powerHtml());
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

  // The phase 3 launch section: fixed economics, the step ladder, the founder
  // mint-create + lock-verify flows, and the on-chain proof checklist. Every
  // commitment is a Solscan link so buyers can verify without trusting us.
  private launchHtml(v: LaunchViewModel): string {
    const page = this.page;
    const symbol = page?.token?.symbol ?? '';
    const lines: string[] = [];
    lines.push(`<h4 class="ro-h">${esc(t('launchpad.launch.title'))}</h4>`);
    lines.push(`<p class="ro-sub">${esc(t('launchpad.launch.subtitle'))}</p>`);

    const steps = v.steps
      .map((s) => {
        const cls = s.done
          ? 'lp-step lp-step-done'
          : s.current
            ? 'lp-step lp-step-current'
            : 'lp-step';
        return `<li class="${cls}">${esc(t(LAUNCH_STEP_KEYS[s.step]))}</li>`;
      })
      .join('');
    lines.push(
      `<ol class="lp-checklist" aria-label="${esc(t('launchpad.launch.stepsAria'))}">${steps}</ol>`,
    );

    if (v.supplyBase !== null) {
      lines.push(
        `<p class="ro-hint">${esc(
          t('launchpad.launch.supply', {
            amount: formatBaseAmount(v.supplyBase, 9),
            symbol,
          }),
        )}</p>`,
      );
      lines.push(
        `<p class="ro-hint ro-hint-muted">${esc(
          t('launchpad.launch.allocLine', {
            publicPct: bpsPercent(v.publicBps),
            liquidityPct: bpsPercent(v.liquidityBps),
          }),
        )}</p>`,
      );
      for (const b of v.buckets) {
        lines.push(`
          <p class="ro-hint ro-hint-muted">${esc(
            t('launchpad.launch.bucketLine', {
              bucket: t(BUCKET_KEYS[b.bucket]),
              pct: bpsPercent(b.shareBps),
              amount: formatBaseAmount(b.amountBase, 9),
              symbol,
              cliff: formatNumber(b.cliffMonths),
              linear: formatNumber(b.linearMonths),
            }),
          )}</p>`);
        if (b.lockAddress) {
          lines.push(
            `<p class="ro-hint ro-hint-muted lp-escrow">${esc(
              t('launchpad.launch.lockProof', { bucket: t(BUCKET_KEYS[b.bucket]) }),
            )} <a href="https://solscan.io/account/${esc(b.lockAddress)}" target="_blank" rel="noopener noreferrer">${esc(b.lockAddress)}</a></p>`,
          );
        }
      }
    }

    if (v.mint) {
      lines.push(
        `<p class="ro-hint lp-escrow">${esc(t('launchpad.launch.mintCreated'))} <a href="https://solscan.io/token/${esc(v.mint)}" target="_blank" rel="noopener noreferrer">${esc(v.mint)}</a></p>`,
      );
    }
    if (v.locksVerified) {
      lines.push(`<p class="ro-hint">${esc(t('launchpad.launch.verifiedNote'))}</p>`);
    }

    if (page?.isOwner) {
      if (!v.mintConfirmed) lines.push(this.mintCreateHtml());
      if (v.needsLockAddresses) lines.push(this.lockVerifyHtml(v));
    }
    if (this.lastChecks) lines.push(this.checksHtml(this.lastChecks));
    return `<section class="lp-launch" aria-label="${esc(t('launchpad.launch.title'))}">${lines.join('')}</section>`;
  }

  private mintCreateHtml(): string {
    return `
      <div class="lp-mint-create">
        <h5 class="ro-h">${esc(t('launchpad.launch.createTitle'))}</h5>
        <p class="ro-sub">${esc(t('launchpad.launch.createHint'))}</p>
        <div class="ro-field">
          <label class="ro-label" for="lp-treasury">${esc(t('launchpad.launch.treasuryLabel'))}</label>
          <input id="lp-treasury" class="ro-input" type="text" autocomplete="off" spellcheck="false" />
          <p class="ro-hint ro-hint-muted">${esc(t('launchpad.launch.treasuryHint'))}</p>
        </div>
        <div class="ro-field">
          <label class="ro-label" for="lp-token-name">${esc(t('launchpad.launch.nameLabel'))}</label>
          <input id="lp-token-name" class="ro-input" type="text" maxlength="32" autocomplete="off" />
        </div>
        <div class="ro-field">
          <label class="ro-label" for="lp-token-uri">${esc(t('launchpad.launch.uriLabel'))}</label>
          <input id="lp-token-uri" class="ro-input" type="text" maxlength="192" autocomplete="off" spellcheck="false" />
        </div>
        <button id="lp-mint-create" class="btn btn-primary" type="button">${esc(t('launchpad.launch.createBtn'))}</button>
      </div>`;
  }

  private lockVerifyHtml(v: LaunchViewModel): string {
    const fields = v.buckets
      .map(
        (b) => `
        <div class="ro-field">
          <label class="ro-label" for="lp-lock-${esc(b.bucket)}">${esc(
            t('launchpad.launch.lockLabel', { bucket: t(BUCKET_KEYS[b.bucket]) }),
          )}</label>
          <input id="lp-lock-${esc(b.bucket)}" class="ro-input" type="text" autocomplete="off"
            spellcheck="false" value="${esc(b.lockAddress ?? '')}" />
        </div>`,
      )
      .join('');
    return `
      <div class="lp-lock-verify">
        <h5 class="ro-h">${esc(t('launchpad.launch.locksTitle'))}</h5>
        <p class="ro-sub">${esc(t('launchpad.launch.locksHint'))}</p>
        ${fields}
        <button id="lp-verify-locks" class="btn btn-primary" type="button">${esc(t('launchpad.launch.verifyBtn'))}</button>
      </div>`;
  }

  private checksHtml(checks: RealmLaunchCheck[]): string {
    const rows = checks
      .map((c) => {
        const { bucket, key } = checkLabel(c.check);
        const label = bucket ? `${t(BUCKET_KEYS[bucket])}: ${t(key)}` : t(key);
        const badge = c.ok ? t('launchpad.launch.checkPass') : t('launchpad.launch.checkFail');
        const detail = c.ok ? '' : ` <code class="lp-check-detail">${esc(c.detail)}</code>`;
        return `<li class="${c.ok ? 'lp-check lp-check-ok' : 'lp-check lp-check-fail'}">${esc(label)}: ${esc(badge)}${detail}</li>`;
      })
      .join('');
    return `
      <ul class="lp-checks" aria-label="${esc(t('launchpad.launch.checksAria'))}">${rows}</ul>`;
  }

  // The phase 4 curve section: live migration progress against the on-chain
  // threshold, the LP-lock share the config commits to, graduation proof
  // links, and the founder's open-curve / verify flows.
  private curveHtml(v: CurveViewModel, status: string): string {
    const page = this.page;
    const lines: string[] = [];
    lines.push(`<h4 class="ro-h">${esc(t('launchpad.curve.title'))}</h4>`);
    lines.push(`<p class="ro-sub">${esc(t('launchpad.curve.subtitle'))}</p>`);
    lines.push(
      `<p class="ro-hint ro-hint-muted">${esc(
        t('launchpad.curve.lpLockLine', { pct: bpsPercent(v.lockedLpBps) }),
      )}</p>`,
    );
    if (v.created && v.poolAddress) {
      lines.push(
        `<p class="ro-hint lp-escrow">${esc(t('launchpad.curve.poolLabel'))} <a href="https://solscan.io/account/${esc(v.poolAddress)}" target="_blank" rel="noopener noreferrer">${esc(v.poolAddress)}</a></p>`,
      );
      lines.push(`
        <div class="lp-bar" role="progressbar" aria-label="${esc(t('launchpad.curve.progressAria'))}"
          aria-valuemin="0" aria-valuemax="100" aria-valuenow="${v.progressPct}">
          <div class="lp-bar-fill" style="width:${v.progressPct}%"></div>
        </div>
        <p class="ro-hint">${esc(
          t('launchpad.curve.progress', {
            raised: formatBaseAmount(v.raisedBase, v.quoteDecimals),
            threshold: formatBaseAmount(v.thresholdBase, v.quoteDecimals),
          }),
        )}</p>`);
      if (v.migrated && !v.graduated) {
        lines.push(`<p class="ro-hint">${esc(t('launchpad.curve.migratedNote'))}</p>`);
      }
    }
    if (v.graduated && v.dammPoolAddress) {
      lines.push(
        `<p class="ro-hint lp-escrow">${esc(t('launchpad.curve.graduatedNote'))} <a href="https://solscan.io/account/${esc(v.dammPoolAddress)}" target="_blank" rel="noopener noreferrer">${esc(v.dammPoolAddress)}</a></p>`,
      );
    }
    if (page?.isOwner) {
      if (status === 'funded' && !v.created && !this.pendingCurveMint) {
        lines.push(`
          <button id="lp-curve-open" class="btn btn-primary" type="button">${esc(t('launchpad.curve.openBtn'))}</button>
          <p class="ro-hint ro-hint-muted">${esc(t('launchpad.curve.openHint'))}</p>`);
      }
      if (this.pendingCurveMint) {
        lines.push(`
          <button id="lp-curve-verify" class="btn btn-primary" type="button">${esc(t('launchpad.curve.verifyBtn'))}</button>
          <p class="ro-hint ro-hint-muted">${esc(t('launchpad.curve.verifyHint'))}</p>`);
      }
      if (status === 'live' && v.migrated && !v.graduated) {
        lines.push(
          `<button id="lp-curve-graduate" class="btn btn-primary" type="button">${esc(t('launchpad.curve.graduateBtn'))}</button>`,
        );
      }
    }
    return `<section class="lp-curve" aria-label="${esc(t('launchpad.curve.title'))}">${lines.join('')}</section>`;
  }

  // The phase 7 power-realm conversion: send realm tokens to the treasury
  // sink, receive in-game copper on a chosen character. Rendered only on a
  // `power` realm with a live token; the server re-checks the policy, the
  // platform flag, and the rate on every quote and confirm.
  private powerHtml(): string {
    const symbol = this.page?.token?.symbol ?? '';
    const characters = this.characters ?? [];
    if (characters.length === 0) {
      return `
        <section class="lp-power" aria-label="${esc(t('launchpad.power.title'))}">
          <h4 class="ro-h">${esc(t('launchpad.power.title'))}</h4>
          <p class="ro-hint ro-hint-muted">${esc(t('launchpad.power.noCharacters'))}</p>
        </section>`;
    }
    const options = characters
      .map((c) => `<option value="${c.id}">${esc(c.name)}</option>`)
      .join('');
    const submitKey: TranslationKey = this.host.linkedWallet()
      ? 'launchpad.power.convertBtn'
      : 'launchpad.power.convertConnect';
    return `
      <section class="lp-power" aria-label="${esc(t('launchpad.power.title'))}">
        <h4 class="ro-h">${esc(t('launchpad.power.title'))}</h4>
        <p class="ro-sub">${esc(t('launchpad.power.subtitle', { symbol }))}</p>
        <div class="ro-field">
          <label class="ro-label" for="lp-power-char">${esc(t('launchpad.power.charLabel'))}</label>
          <select id="lp-power-char" class="ro-input ro-select">${options}</select>
        </div>
        <div class="ro-field">
          <label class="ro-label" for="lp-power-amount">${esc(t('launchpad.power.amountLabel', { symbol }))}</label>
          <input id="lp-power-amount" class="ro-input" type="text" inputmode="decimal" autocomplete="off"
            placeholder="${esc(t('launchpad.presale.amountPlaceholder'))}" />
        </div>
        <button id="lp-power-convert" class="btn btn-primary" type="button">${esc(t(submitKey))}</button>
      </section>`;
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
    this.on('#lp-mint-create', () => void this.mintCreateFlow());
    this.on('#lp-verify-locks', () => void this.verifyLocksFlow());
    this.on('#lp-curve-open', () => void this.openCurveFlow());
    this.on('#lp-curve-verify', () => void this.verifyCurveFlow());
    this.on('#lp-curve-graduate', () => void this.graduationFlow());
    this.on('#lp-power-convert', () => void this.convertPowerFlow());
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

  // Create the mint: the server pins the launch + partial-signs the create
  // transaction, the founder co-signs in their wallet, then the server
  // verifies the finalized creation on-chain and records it.
  private async mintCreateFlow(): Promise<void> {
    const treasury = this.root.querySelector<HTMLInputElement>('#lp-treasury')?.value.trim() ?? '';
    const name = this.root.querySelector<HTMLInputElement>('#lp-token-name')?.value.trim() ?? '';
    const uri = this.root.querySelector<HTMLInputElement>('#lp-token-uri')?.value.trim() ?? '';
    await this.run(async () => {
      const wallet = await this.host.ensureWalletReady();
      if (!wallet) return;
      this.setStatus(t('launchpad.flow.preparingMint'), 'info');
      const prep = await this.host.api.prepareRealmMint(
        this.host.realm.realmId,
        treasury,
        name || undefined,
        uri || undefined,
      );
      this.setStatus(t('launchpad.flow.signingMint'), 'info');
      const sig = await this.host.signServerTransaction(prep.txBase64);
      if (!sig) return; // cancelled in the wallet
      this.setStatus(t('launchpad.flow.confirmingMint'), 'info');
      await this.host.api.confirmRealmMint(this.host.realm.realmId, sig);
      await this.reload();
      this.setStatus(t('launchpad.flow.mintDone'), 'success');
    });
  }

  // Open the bonding curve: the host builds the pool creation (Meteora needs
  // the founder's co-signature; the stub needs no chain write and confirms
  // immediately). The base mint is held until confirm verifies the pool.
  private async openCurveFlow(): Promise<void> {
    await this.run(async () => {
      const wallet = await this.host.ensureWalletReady();
      if (!wallet) return;
      this.setStatus(t('launchpad.flow.preparingCurve'), 'info');
      const prep = await this.host.api.prepareRealmCurve(this.host.realm.realmId);
      if (prep.txBase64) {
        this.setStatus(t('launchpad.flow.signingCurve'), 'info');
        const sig = await this.host.signServerTransaction(prep.txBase64);
        if (!sig) return; // cancelled in the wallet
        this.pendingCurveMint = prep.baseMint;
        this.render();
        this.setStatus(t('launchpad.flow.curveSubmitted'), 'info');
        return;
      }
      // The stub host has no chain write: confirm straight away.
      this.setStatus(t('launchpad.flow.verifyingCurve'), 'info');
      await this.host.api.confirmRealmCurve(this.host.realm.realmId);
      await this.reload();
      this.setStatus(t('launchpad.flow.curveListed'), 'success');
    });
  }

  private async verifyCurveFlow(): Promise<void> {
    const baseMint = this.pendingCurveMint;
    if (!baseMint) return;
    await this.run(async () => {
      this.setStatus(t('launchpad.flow.verifyingCurve'), 'info');
      await this.host.api.confirmRealmCurve(this.host.realm.realmId, baseMint);
      this.pendingCurveMint = null;
      await this.reload();
      this.setStatus(t('launchpad.flow.curveListed'), 'success');
    });
  }

  // Convert realm tokens to copper (phase 7): the server pins the copper
  // amount in a quote, the player pays one Token-2022 transfer into the
  // treasury sink, then the server verifies the finalized transfer and
  // credits the character (live now, or banked for their next join).
  private async convertPowerFlow(): Promise<void> {
    const charRaw = this.root.querySelector<HTMLSelectElement>('#lp-power-char')?.value ?? '';
    const characterId = Number.parseInt(charRaw, 10);
    if (!Number.isInteger(characterId) || characterId <= 0) return;
    const raw = this.root.querySelector<HTMLInputElement>('#lp-power-amount')?.value ?? '';
    const amountBase = parseAmountToBase(raw, 9); // realm tokens are 9 decimals
    if (!amountBase) {
      this.setStatus(t('launchpad.err.invalid_amount'), 'error');
      return;
    }
    await this.run(async () => {
      const wallet = await this.host.ensureWalletReady();
      if (!wallet) return;
      this.setStatus(t('launchpad.flow.quotingPower'), 'info');
      const quote = await this.host.api.quoteRealmPower(
        this.host.realm.realmId,
        characterId,
        amountBase.toString(),
      );
      this.setStatus(
        t('launchpad.flow.powerQuoted', { copper: formatNumber(Number(quote.copperCredit)) }),
        'info',
      );
      const paySig = await this.host.signPowerCredit(quote);
      if (!paySig) return; // cancelled in the wallet
      this.setStatus(t('launchpad.flow.confirmingPower'), 'info');
      const res = await this.host.api.confirmRealmPower(
        this.host.realm.realmId,
        quote.quoteId,
        paySig,
      );
      await this.reload();
      this.setStatus(
        t(res.granted ? 'launchpad.flow.powerCredited' : 'launchpad.flow.powerBanked', {
          copper: formatNumber(Number(res.copperCredit)),
        }),
        'success',
      );
    });
  }

  private async graduationFlow(): Promise<void> {
    await this.run(async () => {
      this.setStatus(t('launchpad.flow.verifyingGraduation'), 'info');
      await this.host.api.confirmRealmGraduation(this.host.realm.realmId);
      await this.reload();
      this.setStatus(t('launchpad.flow.graduated'), 'success');
    });
  }

  // Submit the three Jupiter Lock escrow addresses and run the full on-chain
  // verification; the resulting checklist renders pass/fail per commitment.
  private async verifyLocksFlow(): Promise<void> {
    const read = (bucket: string): string =>
      this.root.querySelector<HTMLInputElement>(`#lp-lock-${bucket}`)?.value.trim() ?? '';
    const founderLock = read('founder');
    const levyLock = read('levy');
    const treasuryLock = read('treasury');
    await this.run(async () => {
      this.setStatus(t('launchpad.flow.verifying'), 'info');
      const res = await this.host.api.verifyRealmLaunch(this.host.realm.realmId, {
        founderLock,
        levyLock,
        treasuryLock,
      });
      this.lastChecks = res.checks;
      await this.reload();
      this.setStatus(
        res.verified ? t('launchpad.flow.verified') : t('launchpad.flow.notVerified'),
        res.verified ? 'success' : 'error',
      );
    });
  }
}
