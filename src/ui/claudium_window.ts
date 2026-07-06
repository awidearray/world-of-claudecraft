// Thin modal window for CLAUDIUM, the server-authoritative soft currency.
//
// The consumer half of the pure-core + thin-consumer split (reference
// daily_rewards_window.ts / vendor_window.ts). It paints #claudium-window from
// the ClaudiumView (claudium_view.ts) and wires buy / spend / redeem / close. It
// owns NO currency logic: every number (balance, SKU credit, price, store cost,
// the crypto amount to send, the split) arrives through the injected deps, which
// read the economy SDK. When the service is off the view is the disabled/empty
// state and this paints a clean notice, never a crash.
//
// The buy tab offers FOUR rails: Card (stripe) plus three native Solana rails
// (SOL, USDC, WOC). Picking a native rail + an amount asks the service for a
// quote, then this paints a copy-and-confirm PAY panel: the exact crypto amount,
// the destination address, the memo/reference, a live countdown, and (WOC) the
// burn/treasury split. The player pays from their own wallet and pastes the tx
// signature to confirm; there is NO wallet auto-send here (this branch's wallet is
// signMessage-only), and the copy-and-confirm flow is the correct end state. The
// redeem tab takes a gift-card code and shows the credited amount.
//
// All strings are t() keys; all interpolation passes through esc(); colors/sizes
// are CSS tokens (class names), no literal hex/px in this module.

import {
  buildClaudiumQuotePanel,
  buildClaudiumView,
  type ClaudiumNativeQuoteInput,
  type ClaudiumNativeRailId,
  type ClaudiumPriceInput,
  type ClaudiumQuotePanel,
  type ClaudiumRailId,
  type ClaudiumRedeemResult,
  type ClaudiumSkuInput,
  type ClaudiumStoreItemInput,
  type ClaudiumView,
  claudiumRailOptions,
  claudiumToUsd,
  formatQuoteCountdown,
} from './claudium_view';
import { markDialogRoot } from './dialog_root';
import { esc } from './esc';
import { formatNumber, type TranslationKey, t } from './i18n';
import { svgIcon } from './ui_icons';

/** The buy rails: the legacy stripe CARD rail plus the three native Solana rails. */
export type ClaudiumRail = ClaudiumRailId;

/** The service-sourced snapshot the window renders (all values from the service). */
export interface ClaudiumSnapshot {
  balance: number | null;
  skus: readonly ClaudiumSkuInput[];
  price: ClaudiumPriceInput;
  storeItems: readonly ClaudiumStoreItemInput[];
}

/** The raw native-quote payload the deps return (mirrors the service SDK shape). */
export type ClaudiumQuotePayload = ClaudiumNativeQuoteInput & {
  /** WOC base-unit decimals ride in the quote; sol/usdc use the fixed table. */
  wocDecimals?: number | null;
};

/** The redeem result the deps return (mirrors the service SDK shape). */
export type ClaudiumRedeemPayload = ClaudiumRedeemResult;

/** The five gift-card occasion templates the picker offers. */
export type ClaudiumGiftOccasion = 'birthday' | 'holiday' | 'congrats' | 'thankyou' | 'generic';

/** How the buyer wants the issued card delivered once the payment settles. */
export type ClaudiumGiftDelivery = 'email' | 'link' | 'reveal';

/**
 * The gift-card purchase inputs the window collects and hands to the quote hook. All
 * money values (amount, split) come back on the quote; the window computes nothing.
 * recipientEmail is required only for email delivery; toSelf is a UI convenience the
 * window resolves to the buyer's own email (or reveal) before quoting.
 */
export interface ClaudiumGiftQuoteInput {
  claudium: number;
  rail: ClaudiumNativeRailId;
  occasion: ClaudiumGiftOccasion;
  delivery: ClaudiumGiftDelivery;
  toSelf: boolean;
  recipientEmail?: string;
  message?: string;
  deliverAtMs?: number;
}

/**
 * The gift-card confirm result: settled + the issued redeem code + cardId (present
 * only once the on-chain payment settles). The window builds the redeem URL + QR from
 * the code; it never fabricates one.
 */
export interface ClaudiumGiftConfirmPayload {
  settled: boolean;
  reason: string | null;
  giftCardCode: string | null;
  cardId: string | null;
}

/** One ledger row the history view renders (mirrors the service LedgerEntryV1). */
export type ClaudiumHistoryReason =
  | 'purchase_stripe'
  | 'purchase_sol'
  | 'purchase_usdc'
  | 'purchase_woc'
  | 'giftcard_redeem'
  | 'spend'
  | 'refund_clawback'
  | 'chargeback_clawback'
  | 'giftcard_void_clawback';

export interface ClaudiumHistoryEntry {
  entryId: string;
  delta: number;
  reason: ClaudiumHistoryReason;
  ref: string;
  atMs: number;
}

/** One newest-first page of ledger entries + the next cursor (null on the last page). */
export interface ClaudiumHistoryPayload {
  entries: ClaudiumHistoryEntry[];
  nextCursor: string | null;
}

/**
 * Hud-supplied glue. The window paints from what these return and reports actions
 * back; it never reaches into Hud. snapshot() is the async service read; buy() runs
 * the legacy stripe flow; spend() redeems a cosmetic. nativeQuote()/nativeConfirm()
 * drive the native-rail pay flow; redeem() drives the gift-card tab. The focus pair
 * comes from Hud.windowFocus(). All of these are absent (return the off state) when
 * the service is off; the window then renders the disabled state.
 */
export interface ClaudiumWindowDeps {
  root(): HTMLElement;
  closeOthers(): void;
  captureFocus(): HTMLElement | null;
  restoreFocus(target: HTMLElement | null): void;
  onVisibilityChange?(): void;
  /** Load the current service snapshot. Rejects only on an unexpected error. */
  snapshot(): Promise<ClaudiumSnapshot>;
  /** Begin a legacy stripe (card) purchase for the chosen SKU. */
  buy(sku: string): void;
  /** Redeem a cosmetic for its Claudium cost. */
  spend(itemId: string, kind: 'cosmetic' | 'skin' | 'item'): void;
  /** Quote a native-rail payment for a Claudium amount, crediting the caller. */
  nativeQuote?(rail: ClaudiumNativeRailId, claudium: number): Promise<ClaudiumQuotePayload>;
  /** Confirm a native payment by reference + the pasted on-chain signature. */
  nativeConfirm?(reference: string, signature: string): Promise<ClaudiumRedeemPayload>;
  /** Redeem a gift-card code into the caller's balance. */
  redeem?(code: string): Promise<ClaudiumRedeemPayload>;
  /**
   * Quote a native-rail payment whose settlement ISSUES a gift card (rather than
   * crediting the buyer). Reuses the same native quote plumbing as nativeQuote; only
   * the fulfillment differs. Returns the same quote payload shape.
   */
  giftcardQuote?(input: ClaudiumGiftQuoteInput): Promise<ClaudiumQuotePayload>;
  /**
   * Confirm a gift-card purchase by reference + the pasted on-chain signature. On
   * success the payload carries the issued redeem code + cardId.
   */
  giftcardConfirm?(reference: string, signature: string): Promise<ClaudiumGiftConfirmPayload>;
  /**
   * Fetch one newest-first page of the caller's Claudium ledger. `before` is the
   * cursor from the prior page; omit it for the first page.
   */
  historyPage?(limit: number, before?: string): Promise<ClaudiumHistoryPayload>;
}

const EMPTY_SNAPSHOT: ClaudiumSnapshot = {
  balance: null,
  skus: [],
  price: { usdPerClaudium: null, wocBaseUnitsPerClaudium: null },
  storeItems: [],
};

type Tab = 'buy' | 'redeem';

function isNativeRail(rail: ClaudiumRailId): rail is ClaudiumNativeRailId {
  return rail === 'sol' || rail === 'usdc' || rail === 'woc';
}

export class ClaudiumWindow {
  private openerFocus: HTMLElement | null = null;
  private renderSeq = 0;
  private tab: Tab = 'buy';
  private selectedRail: ClaudiumRailId = 'stripe';
  // The in-flight native quote (raw payload + the resolved woc decimals) and the
  // Claudium amount it was quoted for. Cleared when the rail/amount changes.
  private quote: ClaudiumQuotePayload | null = null;
  private quoteClaudium: number | null = null;
  private quoteSeq = 0;
  private confirmResult: ClaudiumRedeemPayload | null = null;
  // True while a native confirm is in flight: the pay panel shows a calm
  // "waiting for on-chain confirmation" state instead of dead air (D6).
  private confirmPending = false;
  private redeemResult: ClaudiumRedeemPayload | null = null;
  private countdownTimer: ReturnType<typeof setInterval> | null = null;
  private lastView: ClaudiumView | null = null;

  constructor(private readonly deps: ClaudiumWindowDeps) {}

  get isOpen(): boolean {
    return this.deps.root().style.display === 'block';
  }

  toggle(): void {
    if (this.isOpen) {
      this.close();
      return;
    }
    this.openerFocus = this.deps.captureFocus();
    this.deps.closeOthers();
    const root = this.deps.root();
    root.style.display = 'block';
    this.deps.onVisibilityChange?.();
    this.ensureShell();
    void this.render('open');
  }

  close(): void {
    const root = this.deps.root();
    this.stopCountdown();
    if (root.style.display !== 'block') {
      this.openerFocus = null;
      return;
    }
    root.style.display = 'none';
    this.deps.restoreFocus(this.openerFocus);
    this.openerFocus = null;
    this.deps.onVisibilityChange?.();
  }

  async render(focus: 'open' | null = null): Promise<void> {
    const root = this.deps.root();
    const seq = ++this.renderSeq;
    this.ensureShell();
    if (focus === 'open') (root.querySelector('[data-close]') as HTMLElement | null)?.focus();
    let snapshot: ClaudiumSnapshot;
    try {
      snapshot = await this.deps.snapshot();
    } catch {
      // A thrown read is treated exactly like the service being off: the disabled
      // state. The UI never surfaces a crash.
      snapshot = EMPTY_SNAPSHOT;
    }
    if (!this.isOpen || seq !== this.renderSeq) return;
    this.lastView = buildClaudiumView(snapshot);
    this.paint(this.lastView);
  }

  private ensureShell(): void {
    const root = this.deps.root();
    markDialogRoot(root, { labelledBy: 'claudium-title' });
    if (root.querySelector('.cl-body')) return;
    root.innerHTML = this.titleHtml() + `<div class="cl-body"></div>`;
    root.querySelector('[data-close]')?.addEventListener('click', () => this.close());
  }

  private titleHtml(): string {
    return (
      `<div class="panel-title"><span id="claudium-title">${esc(t('hudChrome.claudium.title'))}</span>` +
      `<button type="button" class="x-btn" data-close aria-label="${esc(t('hudChrome.claudium.close'))}">${svgIcon('close')}</button></div>`
    );
  }

  private paint(view: ClaudiumView): void {
    const body = this.deps.root().querySelector<HTMLElement>('.cl-body');
    if (!body) return;
    const panel = view.disabled
      ? ''
      : `<div id="cl-tabpanel" role="tabpanel" aria-labelledby="cl-tab-${this.tab}">` +
        (this.tab === 'buy' ? this.buyTabHtml(view) : this.redeemTabHtml(view)) +
        `</div>`;
    body.innerHTML =
      this.balanceHtml(view) +
      this.noticeHtml(view) +
      this.tabsHtml(view) +
      panel +
      this.disclosureHtml();
    this.wire(body, view);
    this.syncCountdown();
  }

  private balanceHtml(view: ClaudiumView): string {
    // The balance is the ONE number the disabled state hides: with no service there
    // is no balance to show, so render a dash rather than a fabricated zero. When a
    // balance IS known, show its USD equivalent in parentheses (D2): the peg makes
    // the soft-currency count legible as real money.
    const shown = view.hasBalance
      ? t('hudChrome.claudium.amountWithUsd', {
          amount: formatNumber(view.balance ?? 0, { maximumFractionDigits: 0 }),
          usd: this.usdEquiv(view.balance ?? 0, view.usdPerClaudium),
        })
      : t('hudChrome.claudium.balanceUnit', { amount: '--' });
    return (
      `<div class="cl-balance">` +
      `<span class="cl-balance-label">${esc(t('hudChrome.claudium.balanceLabel'))}</span>` +
      `<strong class="cl-balance-value">${esc(shown)}</strong>` +
      `</div>`
    );
  }

  private noticeHtml(view: ClaudiumView): string {
    if (!view.disabled) return '';
    return `<p class="cl-notice" role="status">${esc(t('hudChrome.claudium.unavailable'))}</p>`;
  }

  private tabsHtml(view: ClaudiumView): string {
    if (view.disabled) return '';
    const tab = (id: Tab, label: string): string => {
      const selected = this.tab === id ? 'true' : 'false';
      const tabIndex = this.tab === id ? '0' : '-1';
      return (
        `<button type="button" class="cl-tab" role="tab" id="cl-tab-${id}" data-tab="${id}" ` +
        `aria-selected="${selected}" aria-controls="cl-tabpanel" tabindex="${tabIndex}">${esc(label)}</button>`
      );
    };
    return (
      `<div class="cl-tabs" role="tablist" aria-label="${esc(t('hudChrome.claudium.tabsLabel'))}">` +
      tab('buy', t('hudChrome.claudium.tabBuy')) +
      tab('redeem', t('hudChrome.claudium.tabRedeem')) +
      `</div>`
    );
  }

  // ---- Buy tab ----------------------------------------------------------------

  private buyTabHtml(view: ClaudiumView): string {
    if (view.disabled) return '';
    return (
      `<section class="cl-section"><h3>${esc(t('hudChrome.claudium.buyTitle'))}</h3>` +
      this.railPickerHtml(view) +
      (isNativeRail(this.selectedRail) ? this.nativePanelHtml() : this.stripeAmountHtml(view)) +
      `</section>` +
      this.storeHtml(view)
    );
  }

  private railPickerHtml(view: ClaudiumView): string {
    const label = (id: ClaudiumRailId): string =>
      id === 'stripe'
        ? t('hudChrome.claudium.railStripe')
        : id === 'sol'
          ? t('hudChrome.claudium.railSol')
          : id === 'usdc'
            ? t('hudChrome.claudium.railUsdc')
            : t('hudChrome.claudium.railWoc');
    const buttons = claudiumRailOptions(view, this.selectedRail)
      .map(
        (opt) =>
          `<button type="button" class="cl-rail" data-rail="${opt.id}" ` +
          `aria-pressed="${opt.selected ? 'true' : 'false'}"${opt.enabled ? '' : ' disabled'}>` +
          `${esc(label(opt.id))}</button>`,
      )
      .join('');
    return `<div class="cl-rails" role="group" aria-label="${esc(t('hudChrome.claudium.railLabel'))}">${buttons}</div>`;
  }

  /** The legacy stripe (card) amount ladder: pick a SKU, buy via the stripe flow. */
  private stripeAmountHtml(view: ClaudiumView): string {
    const rows = view.buyRows
      .map((row) => {
        const usd = this.usdLabel(row.usd);
        const claudium = formatNumber(row.claudium, { maximumFractionDigits: 0 });
        const label = t('hudChrome.claudium.skuRow', { usd, claudium });
        return (
          `<button type="button" class="cl-sku" data-sku="${esc(row.sku)}" aria-label="${esc(label)}">` +
          `<span class="cl-sku-usd">${esc(usd)}</span>` +
          `<span class="cl-sku-claudium">${esc(t('hudChrome.claudium.storeCost', { amount: claudium }))}</span>` +
          `<span class="cl-sku-buy">${esc(t('hudChrome.claudium.buyButton'))}</span>` +
          `</button>`
        );
      })
      .join('');
    const list = view.rails.stripe
      ? `<div class="cl-sku-list">${rows}</div>`
      : `<p class="cl-empty" role="status">${esc(t('hudChrome.claudium.buyUnavailable'))}</p>`;
    return `<div class="cl-amount-label">${esc(t('hudChrome.claudium.amountLabel'))}</div>${list}`;
  }

  /** The native-rail flow: pick an amount to quote, then show the pay panel. */
  private nativePanelHtml(): string {
    if (!this.lastView) return '';
    // Step 1: no quote yet, offer the amount ladder (each rung quotes on click).
    if (this.quote === null || this.quoteClaudium === null) {
      const rows = this.lastView.buyRows
        .map((row) => {
          const claudium = formatNumber(row.claudium, { maximumFractionDigits: 0 });
          const label = t('hudChrome.claudium.amountRow', {
            claudium,
            usd: this.usdLabel(row.usd),
          });
          return (
            `<button type="button" class="cl-sku" data-quote-claudium="${esc(String(row.claudium))}" aria-label="${esc(label)}">` +
            `<span class="cl-sku-claudium">${esc(t('hudChrome.claudium.storeCost', { amount: claudium }))}</span>` +
            `<span class="cl-sku-usd">${esc(this.usdLabel(row.usd))}</span>` +
            `<span class="cl-sku-buy">${esc(t('hudChrome.claudium.quoteButton'))}</span>` +
            `</button>`
          );
        })
        .join('');
      const list = this.lastView.buyRows.length
        ? `<div class="cl-sku-list">${rows}</div>`
        : `<p class="cl-empty" role="status">${esc(t('hudChrome.claudium.buyUnavailable'))}</p>`;
      return `<div class="cl-amount-label">${esc(t('hudChrome.claudium.amountLabel'))}</div>${list}`;
    }
    // Step 2: a quote is in hand, paint the pay panel.
    return this.payPanelHtml(this.currentPanel());
  }

  /** Build the projected quote panel from the raw payload at the current time. */
  private currentPanel(): ClaudiumQuotePanel {
    const rail = isNativeRail(this.selectedRail) ? this.selectedRail : 'sol';
    const woc = rail === 'woc' ? (this.quote?.wocDecimals ?? null) : null;
    return buildClaudiumQuotePanel(rail, this.quote, Date.now(), woc);
  }

  private railName(rail: ClaudiumNativeRailId): string {
    return rail === 'sol'
      ? t('hudChrome.claudium.railSol')
      : rail === 'usdc'
        ? t('hudChrome.claudium.railUsdc')
        : t('hudChrome.claudium.railWoc');
  }

  private payPanelHtml(panel: ClaudiumQuotePanel): string {
    if (panel.disabled) {
      const reason =
        panel.reason === 'rail_disabled'
          ? t('hudChrome.claudium.railDisabled')
          : panel.reason === 'oracle_unavailable'
            ? t('hudChrome.claudium.oracleUnavailable')
            : t('hudChrome.claudium.buyUnavailable');
      // A disabled quote is a plain-language recovery: explain, then offer a fresh
      // quote (re-quote), never a raw reason code (D6 error mapping).
      return (
        `<div class="cl-pay">` +
        `<p class="cl-rail-note" role="status">${esc(reason)}</p>` +
        `<div class="cl-pay-actions">` +
        `<button type="button" class="cl-rail" data-quote-cancel>${esc(t('hudChrome.claudium.requoteButton'))}</button>` +
        `</div>` +
        `</div>`
      );
    }
    const amount = panel.amountDisplay ?? '';
    const railName = this.railName(panel.rail);
    const sendLine = t('hudChrome.claudium.sendExactly', { amount, rail: railName });
    const countdown = panel.expired
      ? t('hudChrome.claudium.quoteExpired')
      : t('hudChrome.claudium.expiresIn', { time: formatQuoteCountdown(panel.countdownMs) });
    // D3: the split shows as ONE clean line ("X WOC burned, Y WOC to treasury") on
    // its own labelled row, never crowding the amount or the treasury address.
    const splitHtml = panel.split
      ? this.field(
          'hudChrome.claudium.splitLabel',
          t('hudChrome.claudium.splitSummary', {
            burn: panel.split.burnDisplay,
            treasury: panel.split.treasuryDisplay,
            rail: railName,
          }),
        )
      : '';
    // D5: an explicit review line before the commit action. For WOC the treasury
    // destination is the split treasury; the USD equivalent uses the quoted
    // Claudium count so the player sees exactly what they pay and receive.
    const usd =
      panel.claudium !== null
        ? this.usdEquiv(panel.claudium, this.lastView?.usdPerClaudium ?? null)
        : '';
    const claudiumText =
      panel.claudium !== null ? formatNumber(panel.claudium, { maximumFractionDigits: 0 }) : '';
    const reviewHtml =
      panel.claudium !== null
        ? this.field(
            'hudChrome.claudium.reviewLabel',
            t('hudChrome.claudium.reviewLine', {
              pay: amount,
              rail: railName,
              claudium: claudiumText,
              usd,
            }),
          )
        : '';
    // D6: a calm pending state while the confirm is in flight; a reassuring retry
    // state on not_finalized; plain-language success/failure otherwise.
    const confirmDone = this.confirmStatusHtml();
    return (
      `<div class="cl-pay">` +
      `<p class="cl-pay-amount"><strong>${esc(sendLine)}</strong></p>` +
      reviewHtml +
      this.fieldWithCopy('hudChrome.claudium.addressLabel', panel.destination ?? '') +
      this.field('hudChrome.claudium.memoLabel', panel.memo ?? '') +
      splitHtml +
      `<p class="cl-countdown" role="status">${esc(countdown)}</p>` +
      `<p class="cl-pay-note">${esc(t('hudChrome.claudium.payNote'))}</p>` +
      `<label class="cl-field-label" for="cl-sig">${esc(t('hudChrome.claudium.signatureLabel'))}</label>` +
      `<input id="cl-sig" class="cl-sig-input" type="text" autocomplete="off" spellcheck="false" ` +
      `placeholder="${esc(t('hudChrome.claudium.signaturePlaceholder'))}" />` +
      `<div class="cl-pay-actions">` +
      `<button type="button" class="cl-rail" data-quote-cancel>${esc(t('hudChrome.claudium.back'))}</button>` +
      `<button type="button" class="cl-item-buy" data-quote-confirm${this.confirmPending ? ' disabled' : ''}>${esc(t('hudChrome.claudium.confirmButton'))}</button>` +
      `</div>` +
      confirmDone +
      `</div>`
    );
  }

  private field(labelKey: TranslationKey, value: string): string {
    // Each field on its OWN row with a clear label above the value (D3): the label
    // is a block, the value a block, so nothing runs together.
    return (
      `<div class="cl-field">` +
      `<span class="cl-field-label">${esc(t(labelKey))}</span>` +
      `<code class="cl-field-value">${esc(value)}</code>` +
      `</div>`
    );
  }

  private fieldWithCopy(labelKey: TranslationKey, value: string): string {
    return (
      `<div class="cl-field">` +
      `<span class="cl-field-label">${esc(t(labelKey))}</span>` +
      `<div class="cl-field-copy">` +
      `<code class="cl-field-value cl-address">${esc(value)}</code>` +
      `<button type="button" class="cl-copy-btn" data-copy-address="${esc(value)}" aria-label="${esc(t('hudChrome.claudium.copyAddress'))}">${esc(t('hudChrome.claudium.copyAddress'))}</button>` +
      `</div>` +
      `</div>`
    );
  }

  /**
   * The confirm status line under the pay actions. Order: an in-flight confirm is a
   * calm pending line (D6); then the result maps to plain-language copy with a
   * recovery action, never a raw reason code. not_finalized is reassuring (retry),
   * an expired/oracle reason offers a fresh quote, other failures a plain retry.
   */
  private confirmStatusHtml(): string {
    if (this.confirmPending) {
      return `<p class="cl-rail-note cl-pending" role="status">${esc(t('hudChrome.claudium.confirmPending'))}</p>`;
    }
    const result = this.confirmResult;
    if (!result) return '';
    if (result.credited) {
      return (
        `<p class="cl-rail-note cl-success" role="status">` +
        esc(
          t('hudChrome.claudium.confirmCredited', {
            amount: formatNumber(result.balance ?? 0, { maximumFractionDigits: 0 }),
          }),
        ) +
        `</p>`
      );
    }
    const reason = result.reason;
    if (reason === 'not_finalized') {
      return (
        `<p class="cl-rail-note" role="status">${esc(t('hudChrome.claudium.confirmNotFinalized'))}</p>` +
        `<div class="cl-pay-actions"><button type="button" class="cl-rail" data-quote-confirm>${esc(t('hudChrome.claudium.retryButton'))}</button></div>`
      );
    }
    if (reason === 'expired' || reason === 'oracle_unavailable') {
      return (
        `<p class="cl-rail-note" role="status">${esc(t('hudChrome.claudium.confirmRequote'))}</p>` +
        `<div class="cl-pay-actions"><button type="button" class="cl-rail" data-quote-cancel>${esc(t('hudChrome.claudium.requoteButton'))}</button></div>`
      );
    }
    return `<p class="cl-rail-note" role="status">${esc(t('hudChrome.claudium.confirmFailed'))}</p>`;
  }

  private usdLabel(usd: number): string {
    // The service sends whole-dollar SKUs ($1..$10000). Render with locale grouping
    // but no cents, so $10000 reads $10,000 in en and localizes elsewhere.
    return t('hudChrome.claudium.usdAmount', {
      usd: formatNumber(usd, { maximumFractionDigits: 0 }),
    });
  }

  /**
   * The USD equivalent of a Claudium amount at the view's peg, as a $ figure with
   * cents. Used where no per-row USD is present (the balance, a store price). The
   * peg is service-owned; this only projects it (claudiumToUsd), it never prices.
   */
  private usdEquiv(claudium: number, usdPerClaudium: number | null): string {
    const usd = claudiumToUsd(claudium, usdPerClaudium);
    return t('hudChrome.claudium.usdAmount', {
      usd: formatNumber(usd, { minimumFractionDigits: 2, maximumFractionDigits: 2 }),
    });
  }

  // ---- Cosmetic store (shared under the buy tab) ------------------------------

  private storeHtml(view: ClaudiumView): string {
    if (view.disabled) return '';
    const kindLabel = (kind: 'cosmetic' | 'skin' | 'item'): string =>
      kind === 'skin'
        ? t('hudChrome.claudium.kindSkin')
        : kind === 'item'
          ? t('hudChrome.claudium.kindItem')
          : t('hudChrome.claudium.kindCosmetic');
    const rows =
      view.storeRows.length === 0
        ? `<p class="cl-empty" role="status">${esc(t('hudChrome.claudium.storeEmpty'))}</p>`
        : view.storeRows
            .map((row) => {
              // Show the cost with its USD equivalent (D2), so a store price reads
              // as real money like the balance and SKU rows do.
              const cost = t('hudChrome.claudium.amountWithUsd', {
                amount: formatNumber(row.costClaudium, { maximumFractionDigits: 0 }),
                usd: this.usdEquiv(row.costClaudium, view.usdPerClaudium),
              });
              // D7: when the balance cannot cover this item, swap the redeem button
              // for a "top up" affordance that jumps back to the buy tab.
              const affordable = view.balance !== null && view.balance >= row.costClaudium;
              const action = affordable
                ? `<button type="button" class="cl-item-buy" data-item="${esc(row.itemId)}" data-kind="${esc(row.kind)}" aria-label="${esc(cost)}">${esc(t('hudChrome.claudium.spendButton'))}</button>`
                : `<div class="cl-item-topup">` +
                  `<span class="cl-item-short">${esc(t('hudChrome.claudium.insufficientBalance'))}</span>` +
                  `<button type="button" class="cl-topup-btn" data-topup>${esc(t('hudChrome.claudium.topUpButton'))}</button>` +
                  `</div>`;
              return (
                `<div class="cl-item">` +
                `<span class="cl-item-name">${esc(row.name)}</span>` +
                `<span class="cl-item-kind">${esc(kindLabel(row.kind))}</span>` +
                `<span class="cl-item-cost">${esc(cost)}</span>` +
                action +
                `</div>`
              );
            })
            .join('');
    return `<section class="cl-section"><h3>${esc(t('hudChrome.claudium.storeTitle'))}</h3><div class="cl-item-list">${rows}</div></section>`;
  }

  // ---- Redeem tab -------------------------------------------------------------

  private redeemTabHtml(view: ClaudiumView): string {
    if (view.disabled) return '';
    const result = this.redeemResult;
    const resultHtml = result
      ? `<p class="cl-rail-note" role="status">` +
        esc(
          result.credited
            ? t('hudChrome.claudium.redeemed', {
                amount: formatNumber(result.denominationClaudium ?? 0, {
                  maximumFractionDigits: 0,
                }),
                balance: formatNumber(result.balance ?? 0, { maximumFractionDigits: 0 }),
              })
            : t('hudChrome.claudium.redeemFailed'),
        ) +
        `</p>`
      : '';
    return (
      `<section class="cl-section"><h3>${esc(t('hudChrome.claudium.redeemTitle'))}</h3>` +
      `<label class="cl-field-label" for="cl-code">${esc(t('hudChrome.claudium.enterCode'))}</label>` +
      `<input id="cl-code" class="cl-sig-input" type="text" autocomplete="off" spellcheck="false" ` +
      `placeholder="${esc(t('hudChrome.claudium.codePlaceholder'))}" />` +
      `<div class="cl-pay-actions">` +
      `<button type="button" class="cl-item-buy" data-redeem>${esc(t('hudChrome.claudium.redeemButton'))}</button>` +
      `</div>` +
      resultHtml +
      `</section>`
    );
  }

  private disclosureHtml(): string {
    return `<p class="cl-disclosure">${esc(t('hudChrome.claudium.disclosure'))}</p>`;
  }

  // ---- Wiring -----------------------------------------------------------------

  private wire(body: HTMLElement, view: ClaudiumView): void {
    body.querySelectorAll<HTMLButtonElement>('[data-tab]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const next: Tab = btn.dataset.tab === 'redeem' ? 'redeem' : 'buy';
        if (next === this.tab) return;
        this.tab = next;
        this.paint(view);
      });
    });
    body.querySelectorAll<HTMLButtonElement>('[data-rail]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const rail = (btn.dataset.rail ?? 'stripe') as ClaudiumRailId;
        if (btn.disabled) return;
        if (rail === this.selectedRail) return;
        this.selectedRail = rail;
        // Switching rails abandons any in-flight quote.
        this.clearQuote();
        this.paint(view);
      });
    });
    // Legacy stripe SKU buy.
    body.querySelectorAll<HTMLButtonElement>('[data-sku]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const sku = btn.dataset.sku;
        if (sku) this.deps.buy(sku);
      });
    });
    // Native-rail: request a quote for the chosen Claudium amount.
    body.querySelectorAll<HTMLButtonElement>('[data-quote-claudium]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const claudium = Number(btn.dataset.quoteClaudium);
        if (Number.isFinite(claudium) && claudium > 0) void this.requestQuote(claudium, view);
      });
    });
    body.querySelector<HTMLButtonElement>('[data-quote-cancel]')?.addEventListener('click', () => {
      this.clearQuote();
      this.paint(view);
    });
    body.querySelectorAll<HTMLButtonElement>('[data-quote-confirm]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const sig = body.querySelector<HTMLInputElement>('#cl-sig')?.value.trim() ?? '';
        void this.confirmNative(sig, view);
      });
    });
    body.querySelectorAll<HTMLButtonElement>('[data-copy-address]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const addr = btn.dataset.copyAddress ?? '';
        if (addr) void navigator.clipboard?.writeText(addr).catch(() => {});
        btn.textContent = t('hudChrome.claudium.copied');
      });
    });
    body.querySelector<HTMLButtonElement>('[data-redeem]')?.addEventListener('click', () => {
      const code = body.querySelector<HTMLInputElement>('#cl-code')?.value.trim() ?? '';
      void this.doRedeem(code, view);
    });
    body.querySelectorAll<HTMLButtonElement>('[data-item]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const itemId = btn.dataset.item;
        const kind = btn.dataset.kind;
        if (itemId && (kind === 'cosmetic' || kind === 'skin' || kind === 'item')) {
          this.deps.spend(itemId, kind);
        }
      });
    });
    // D7: the store "top up" affordance jumps back to the buy tab (where the store
    // and the rail picker live) and scrolls the buy controls into view.
    body.querySelector<HTMLButtonElement>('[data-topup]')?.addEventListener('click', () => {
      if (this.tab !== 'buy') this.tab = 'buy';
      this.clearQuote();
      this.paint(view);
      const railsEl = this.deps.root().querySelector('.cl-rails');
      railsEl?.scrollIntoView({ block: 'nearest' });
      (railsEl?.querySelector('.cl-rail:not(:disabled)') as HTMLElement | null)?.focus();
    });
  }

  private async requestQuote(claudium: number, view: ClaudiumView): Promise<void> {
    if (!isNativeRail(this.selectedRail) || !this.deps.nativeQuote) return;
    const rail = this.selectedRail;
    const seq = ++this.quoteSeq;
    let payload: ClaudiumQuotePayload;
    try {
      payload = await this.deps.nativeQuote(rail, claudium);
    } catch {
      payload = {
        reference: null,
        rail,
        claudium,
        amountBase: null,
        destination: null,
        mint: null,
        memo: null,
        quoteExpiryMs: null,
        split: null,
        reason: 'unavailable',
      };
    }
    if (!this.isOpen || seq !== this.quoteSeq || this.selectedRail !== rail) return;
    this.quote = payload;
    this.quoteClaudium = claudium;
    this.confirmResult = null;
    this.paint(view);
  }

  private async confirmNative(signature: string, view: ClaudiumView): Promise<void> {
    if (!this.deps.nativeConfirm || !this.quote?.reference || signature === '') return;
    if (this.confirmPending) return;
    const reference = this.quote.reference;
    // Show the calm pending state immediately, then await the on-chain check (D6).
    this.confirmPending = true;
    this.confirmResult = null;
    this.paint(view);
    let result: ClaudiumRedeemPayload;
    try {
      result = await this.deps.nativeConfirm(reference, signature);
    } catch {
      result = {
        credited: false,
        balance: null,
        denominationClaudium: null,
        reason: 'unavailable',
      };
    }
    if (!this.isOpen) return;
    this.confirmPending = false;
    this.confirmResult = result;
    // A credited confirm refreshes the balance from the service on the next render.
    if (result.credited) void this.render();
    else this.paint(view);
  }

  private async doRedeem(code: string, view: ClaudiumView): Promise<void> {
    if (!this.deps.redeem || code === '') return;
    let result: ClaudiumRedeemPayload;
    try {
      result = await this.deps.redeem(code);
    } catch {
      result = {
        credited: false,
        balance: null,
        denominationClaudium: null,
        reason: 'unavailable',
      };
    }
    if (!this.isOpen) return;
    this.redeemResult = result;
    if (result.credited) void this.render();
    else this.paint(view);
  }

  private clearQuote(): void {
    this.quote = null;
    this.quoteClaudium = null;
    this.confirmResult = null;
    this.confirmPending = false;
    this.stopCountdown();
  }

  // ---- Live countdown ---------------------------------------------------------

  /** Repaint only the countdown line each second while a live quote is showing. */
  private syncCountdown(): void {
    const showing =
      this.tab === 'buy' &&
      isNativeRail(this.selectedRail) &&
      this.quote !== null &&
      this.quote.reason === null &&
      this.quote.quoteExpiryMs !== null;
    if (!showing) {
      this.stopCountdown();
      return;
    }
    if (this.countdownTimer) return;
    this.countdownTimer = setInterval(() => this.tickCountdown(), 1000);
  }

  private tickCountdown(): void {
    if (!this.isOpen) {
      this.stopCountdown();
      return;
    }
    const el = this.deps.root().querySelector<HTMLElement>('.cl-countdown');
    if (!el) {
      this.stopCountdown();
      return;
    }
    const panel = this.currentPanel();
    el.textContent = panel.expired
      ? t('hudChrome.claudium.quoteExpired')
      : t('hudChrome.claudium.expiresIn', { time: formatQuoteCountdown(panel.countdownMs) });
  }

  private stopCountdown(): void {
    if (this.countdownTimer) {
      clearInterval(this.countdownTimer);
      this.countdownTimer = null;
    }
  }
}
