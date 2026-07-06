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
    body.innerHTML =
      this.balanceHtml(view) +
      this.noticeHtml(view) +
      this.tabsHtml(view) +
      (this.tab === 'buy' ? this.buyTabHtml(view) : this.redeemTabHtml(view)) +
      this.disclosureHtml();
    this.wire(body, view);
    this.syncCountdown();
  }

  private balanceHtml(view: ClaudiumView): string {
    // The balance is the ONE number the disabled state hides: with no service there
    // is no balance to show, so render a dash rather than a fabricated zero.
    const shown = view.hasBalance
      ? t('hudChrome.claudium.balanceUnit', {
          amount: formatNumber(view.balance ?? 0, { maximumFractionDigits: 0 }),
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
      const pressed = this.tab === id ? 'true' : 'false';
      return `<button type="button" class="cl-tab" data-tab="${id}" aria-pressed="${pressed}">${esc(label)}</button>`;
    };
    return (
      `<div class="cl-tabs" role="group" aria-label="${esc(t('hudChrome.claudium.tabsLabel'))}">` +
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

  private payPanelHtml(panel: ClaudiumQuotePanel): string {
    if (panel.disabled) {
      const reason =
        panel.reason === 'rail_disabled'
          ? t('hudChrome.claudium.railDisabled')
          : panel.reason === 'oracle_unavailable'
            ? t('hudChrome.claudium.oracleUnavailable')
            : t('hudChrome.claudium.buyUnavailable');
      return (
        `<div class="cl-pay">` +
        `<p class="cl-rail-note" role="status">${esc(reason)}</p>` +
        `<button type="button" class="cl-rail" data-quote-cancel>${esc(t('hudChrome.claudium.back'))}</button>` +
        `</div>`
      );
    }
    const amount = panel.amountDisplay ?? '';
    const railName =
      panel.rail === 'sol'
        ? t('hudChrome.claudium.railSol')
        : panel.rail === 'usdc'
          ? t('hudChrome.claudium.railUsdc')
          : t('hudChrome.claudium.railWoc');
    const sendLine = t('hudChrome.claudium.sendExactly', { amount, rail: railName });
    const countdown = panel.expired
      ? t('hudChrome.claudium.quoteExpired')
      : t('hudChrome.claudium.expiresIn', { time: formatQuoteCountdown(panel.countdownMs) });
    const splitHtml = panel.split
      ? `<div class="cl-split">` +
        `<span class="cl-split-line">${esc(t('hudChrome.claudium.splitBurn', { amount: panel.split.burnDisplay, rail: railName }))}</span>` +
        `<span class="cl-split-line">${esc(t('hudChrome.claudium.splitTreasury', { amount: panel.split.treasuryDisplay, rail: railName }))}</span>` +
        `</div>`
      : '';
    const field = (labelKey: TranslationKey, value: string): string =>
      `<div class="cl-field">` +
      `<span class="cl-field-label">${esc(t(labelKey))}</span>` +
      `<code class="cl-field-value">${esc(value)}</code>` +
      `</div>`;
    const confirmDone = this.confirmResult
      ? `<p class="cl-rail-note" role="status">` +
        esc(
          this.confirmResult.credited
            ? t('hudChrome.claudium.confirmCredited', {
                amount: formatNumber(this.confirmResult.balance ?? 0, { maximumFractionDigits: 0 }),
              })
            : t('hudChrome.claudium.confirmFailed'),
        ) +
        `</p>`
      : '';
    return (
      `<div class="cl-pay">` +
      `<p class="cl-pay-amount"><strong>${esc(sendLine)}</strong></p>` +
      field('hudChrome.claudium.addressLabel', panel.destination ?? '') +
      field('hudChrome.claudium.memoLabel', panel.memo ?? '') +
      splitHtml +
      `<p class="cl-countdown" role="status">${esc(countdown)}</p>` +
      `<p class="cl-pay-note">${esc(t('hudChrome.claudium.payNote'))}</p>` +
      `<label class="cl-field-label" for="cl-sig">${esc(t('hudChrome.claudium.signatureLabel'))}</label>` +
      `<input id="cl-sig" class="cl-sig-input" type="text" autocomplete="off" spellcheck="false" ` +
      `placeholder="${esc(t('hudChrome.claudium.signaturePlaceholder'))}" />` +
      `<div class="cl-pay-actions">` +
      `<button type="button" class="cl-rail" data-quote-cancel>${esc(t('hudChrome.claudium.back'))}</button>` +
      `<button type="button" class="cl-item-buy" data-quote-confirm>${esc(t('hudChrome.claudium.confirmButton'))}</button>` +
      `</div>` +
      confirmDone +
      `</div>`
    );
  }

  private usdLabel(usd: number): string {
    // The service sends whole-dollar SKUs ($1..$10000). Render with locale grouping
    // but no cents, so $10000 reads $10,000 in en and localizes elsewhere.
    return `$${formatNumber(usd, { maximumFractionDigits: 0 })}`;
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
              const cost = t('hudChrome.claudium.storeCost', {
                amount: formatNumber(row.costClaudium, { maximumFractionDigits: 0 }),
              });
              return (
                `<div class="cl-item">` +
                `<span class="cl-item-name">${esc(row.name)}</span>` +
                `<span class="cl-item-kind">${esc(kindLabel(row.kind))}</span>` +
                `<span class="cl-item-cost">${esc(cost)}</span>` +
                `<button type="button" class="cl-item-buy" data-item="${esc(row.itemId)}" data-kind="${esc(row.kind)}" aria-label="${esc(cost)}">${esc(t('hudChrome.claudium.spendButton'))}</button>` +
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
    body.querySelector<HTMLButtonElement>('[data-quote-confirm]')?.addEventListener('click', () => {
      const sig = body.querySelector<HTMLInputElement>('#cl-sig')?.value.trim() ?? '';
      void this.confirmNative(sig, view);
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
    const reference = this.quote.reference;
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
