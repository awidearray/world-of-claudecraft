// Pure, host-agnostic view model for the CLAUDIUM window.
//
// The pure-core half of the pure-core + thin-consumer split (root CLAUDE.md
// Conventions; reference vendor_view.ts / stat_tooltip_view.ts). CLAUDIUM is a
// server-authoritative soft currency: the peg, prices, SKU credits, balance, and
// store costs ALL come from the economy service. This core recomputes NONE of
// them; it only projects the service payloads into the render rows and the
// per-rail availability the window paints. DOM-free and i18n-free so
// tests/claudium_view.test.ts can drive it directly.
//
// The one non-negotiable: when the balance is null (the service is off) the model
// is a clean disabled/empty state, NEVER an error crash.

/** A price rung as returned by the service (usd + Claudium credited). */
export interface ClaudiumSkuInput {
  sku: string;
  usd: number;
  claudium: number;
}

/** Per-rail price. usdPerClaudium fixes the display peg; woc base-units null => oracle down. */
export interface ClaudiumPriceInput {
  usdPerClaudium: number | null;
  wocBaseUnitsPerClaudium: number | null;
}

/** A cosmetic-store row as returned by the service (name + Claudium cost). */
export interface ClaudiumStoreItemInput {
  itemId: string;
  name: string;
  kind: 'cosmetic' | 'skin' | 'item';
  costClaudium: number;
}

/** The raw inputs, all sourced from the service via the SDK. */
export interface ClaudiumViewInput {
  /** Integer Claudium balance, or null when the service is off. */
  balance: number | null;
  skus: readonly ClaudiumSkuInput[];
  price: ClaudiumPriceInput;
  storeItems: readonly ClaudiumStoreItemInput[];
}

/** One buy-picker row: the money label and the Claudium credited, both from the service. */
export interface ClaudiumBuyRow {
  sku: string;
  usd: number;
  claudium: number;
}

/** One cosmetic-store row: the item, its kind, and its Claudium cost, from the service. */
export interface ClaudiumStoreRow {
  itemId: string;
  name: string;
  kind: 'cosmetic' | 'skin' | 'item';
  costClaudium: number;
}

/** Which purchase rails the window may enable. */
export interface ClaudiumRailAvailability {
  /** Stripe is available when there is at least one SKU rung to buy. */
  stripe: boolean;
  /** WOC is available only when the oracle price (base units per Claudium) is present. */
  woc: boolean;
}

/** The four buy rails: the legacy stripe CARD rail plus three native Solana rails. */
export type ClaudiumRailId = 'stripe' | 'sol' | 'usdc' | 'woc';

/** The three native rails (a subset of ClaudiumRailId), quoted by the service. */
export type ClaudiumNativeRailId = 'sol' | 'usdc' | 'woc';

/** One rail option in the picker: its id, whether it is selected, and if it is enabled. */
export interface ClaudiumRailOption {
  id: ClaudiumRailId;
  selected: boolean;
  enabled: boolean;
}

/**
 * A native-rail quote as the service returns it. The view projects this into a
 * panel; it never derives amountBase, the split, or the expiry. reason is set when
 * the rail is disabled or the oracle is down (the panel then renders disabled).
 */
export interface ClaudiumNativeQuoteInput {
  reference: string | null;
  rail: ClaudiumNativeRailId | null;
  claudium: number | null;
  amountBase: string | null;
  destination: string | null;
  mint: string | null;
  memo: string | null;
  quoteExpiryMs: number | null;
  split: { burnBase: string; treasuryBase: string; treasury: string } | null;
  reason: 'oracle_unavailable' | 'rail_disabled' | string | null;
}

/** The base-unit decimals per native rail. SOL and USDC are fixed; WOC comes from the quote. */
export const NATIVE_RAIL_DECIMALS: Record<'sol' | 'usdc', number> = { sol: 9, usdc: 6 };

/**
 * The projected quote panel. amountDisplay is amountBase re-scaled by the rail's
 * decimals (the ONLY formatting the view does, and it is a pure base-10 shift of a
 * service-provided integer string, never a price computation). countdownMs is the
 * live time left until quoteExpiryMs; expired is true once it hits zero. split is
 * the WOC burn/treasury line, present only on the woc rail. disabled is true (with
 * a reason) when the quote is unusable.
 */
export interface ClaudiumQuotePanel {
  rail: ClaudiumNativeRailId;
  disabled: boolean;
  /** 'rail_disabled' | 'oracle_unavailable' | 'unavailable' when disabled, else null. */
  reason: string | null;
  reference: string | null;
  claudium: number | null;
  amountBase: string | null;
  amountDisplay: string | null;
  decimals: number | null;
  destination: string | null;
  memo: string | null;
  quoteExpiryMs: number | null;
  countdownMs: number;
  expired: boolean;
  split: {
    burnBase: string;
    burnDisplay: string;
    treasuryBase: string;
    treasuryDisplay: string;
    treasury: string;
  } | null;
}

/** The redeem-tab result state. */
export interface ClaudiumRedeemResult {
  credited: boolean;
  balance: number | null;
  denominationClaudium: number | null;
  reason: string | null;
}

export interface ClaudiumView {
  /** True when the service is off (balance null): render the disabled/empty state. */
  disabled: boolean;
  /** Whether a numeric balance is known (false in the disabled state). */
  hasBalance: boolean;
  /** The integer balance to render, or null in the disabled state. */
  balance: number | null;
  buyRows: ClaudiumBuyRow[];
  rails: ClaudiumRailAvailability;
  /** True when neither rail can transact (nothing to buy or oracle down + no skus). */
  buyDisabled: boolean;
  storeRows: ClaudiumStoreRow[];
}

/**
 * Project the service payloads into the render model.
 *
 * Disabled state: a null balance means the service is off, so every buy/store row
 * is dropped and both rails are unavailable, a clean empty state (not an error).
 * Funded state: buy rows mirror the SKU ladder verbatim; stripe is available when
 * the ladder is non-empty; woc is available only when the oracle price is present;
 * store rows mirror the service catalog verbatim.
 */
export function buildClaudiumView(input: ClaudiumViewInput): ClaudiumView {
  const disabled = input.balance === null;
  if (disabled) {
    return {
      disabled: true,
      hasBalance: false,
      balance: null,
      buyRows: [],
      rails: { stripe: false, woc: false },
      buyDisabled: true,
      storeRows: [],
    };
  }

  const buyRows: ClaudiumBuyRow[] = input.skus.map((s) => ({
    sku: s.sku,
    usd: s.usd,
    claudium: s.claudium,
  }));
  const stripe = buyRows.length > 0;
  const woc = buyRows.length > 0 && input.price.wocBaseUnitsPerClaudium !== null;
  const storeRows: ClaudiumStoreRow[] = input.storeItems.map((i) => ({
    itemId: i.itemId,
    name: i.name,
    kind: i.kind,
    costClaudium: i.costClaudium,
  }));

  return {
    disabled: false,
    hasBalance: true,
    balance: input.balance,
    buyRows,
    rails: { stripe, woc },
    buyDisabled: !stripe && !woc,
    storeRows,
  };
}

/** The four rails in fixed display order: Card, then the three native Solana rails. */
export const CLAUDIUM_RAIL_ORDER: readonly ClaudiumRailId[] = ['stripe', 'sol', 'usdc', 'woc'];

/**
 * Project the rail picker. Every rail is always shown so the player sees the full
 * set; a rail is enabled only when it can transact. The native rails share stripe's
 * "there is something to buy" gate (a non-empty SKU ladder / a funded state); a
 * rail whose live quote later comes back disabled renders its panel disabled, which
 * is a separate, per-quote signal from this coarse picker availability. The service
 * being off (disabled view) leaves every rail disabled.
 */
export function claudiumRailOptions(
  view: ClaudiumView,
  selected: ClaudiumRailId,
): ClaudiumRailOption[] {
  const anyBuyable = !view.disabled && view.buyRows.length > 0;
  return CLAUDIUM_RAIL_ORDER.map((id) => ({
    id,
    selected: id === selected,
    // Card gates on a SKU rung existing; the native rails on the same funded state.
    // The per-quote disable (rail_disabled / oracle_unavailable) is enforced in the
    // quote panel, not here, so a picker rail can be enabled yet its quote disabled.
    enabled: id === 'stripe' ? view.rails.stripe : anyBuyable,
  }));
}

/**
 * Re-scale a service base-unit integer STRING by `decimals`, producing a plain
 * decimal string. This is a pure base-10 shift of a service-provided integer, not
 * a price computation: the service already decided amountBase; the view only moves
 * the decimal point so a human can read it. Trailing zeros are trimmed; a
 * whole-number amount renders with no fractional part. Returns null on a malformed
 * input rather than fabricating a number.
 */
export function scaleBaseUnits(amountBase: string | null, decimals: number): string | null {
  if (amountBase === null || !/^\d+$/.test(amountBase)) return null;
  if (decimals <= 0) return amountBase.replace(/^0+(?=\d)/, '');
  const padded = amountBase.padStart(decimals + 1, '0');
  const whole = padded.slice(0, padded.length - decimals).replace(/^0+(?=\d)/, '');
  const frac = padded.slice(padded.length - decimals).replace(/0+$/, '');
  return frac === '' ? whole : `${whole}.${frac}`;
}

/**
 * Project a native quote into the panel model at a given wall-clock `nowMs` (the
 * consumer passes Date.now(); the core stays pure so tests pin the countdown).
 * The WOC decimals ride in the quote (base units per Claudium is opaque here), so
 * the consumer passes the resolved `wocDecimals` for the woc rail; sol/usdc use the
 * fixed table. A disabled/absent quote yields a disabled panel with the reason.
 */
export function buildClaudiumQuotePanel(
  rail: ClaudiumNativeRailId,
  quote: ClaudiumNativeQuoteInput | null,
  nowMs: number,
  wocDecimals: number | null,
): ClaudiumQuotePanel {
  const base = {
    rail,
    reference: null,
    claudium: null,
    amountBase: null,
    amountDisplay: null,
    decimals: null,
    destination: null,
    memo: null,
    quoteExpiryMs: null,
    countdownMs: 0,
    expired: true,
    split: null,
  } as const;
  if (!quote || quote.reason) {
    return { ...base, disabled: true, reason: quote?.reason ?? 'unavailable' };
  }
  const decimals =
    rail === 'sol'
      ? NATIVE_RAIL_DECIMALS.sol
      : rail === 'usdc'
        ? NATIVE_RAIL_DECIMALS.usdc
        : wocDecimals;
  const amountDisplay = decimals === null ? null : scaleBaseUnits(quote.amountBase, decimals);
  const countdownMs = quote.quoteExpiryMs === null ? 0 : Math.max(0, quote.quoteExpiryMs - nowMs);
  const split =
    rail === 'woc' && quote.split && decimals !== null
      ? {
          burnBase: quote.split.burnBase,
          burnDisplay: scaleBaseUnits(quote.split.burnBase, decimals) ?? quote.split.burnBase,
          treasuryBase: quote.split.treasuryBase,
          treasuryDisplay:
            scaleBaseUnits(quote.split.treasuryBase, decimals) ?? quote.split.treasuryBase,
          treasury: quote.split.treasury,
        }
      : null;
  return {
    rail,
    disabled: false,
    reason: null,
    reference: quote.reference,
    claudium: quote.claudium,
    amountBase: quote.amountBase,
    amountDisplay,
    decimals,
    destination: quote.destination,
    memo: quote.memo,
    quoteExpiryMs: quote.quoteExpiryMs,
    countdownMs,
    expired: countdownMs <= 0,
    split,
  };
}

/**
 * Format a live countdown (ms remaining) as mm:ss. Pure; the consumer recomputes
 * countdownMs each tick from Date.now() and calls this. Clamps at 0.
 */
export function formatQuoteCountdown(countdownMs: number): string {
  const total = Math.max(0, Math.floor(countdownMs / 1000));
  const mm = Math.floor(total / 60);
  const ss = total % 60;
  return `${String(mm).padStart(2, '0')}:${String(ss).padStart(2, '0')}`;
}
