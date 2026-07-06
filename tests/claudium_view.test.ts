import { describe, expect, it } from 'vitest';
import {
  buildClaudiumQuotePanel,
  buildClaudiumView,
  CLAUDIUM_RAIL_ORDER,
  type ClaudiumNativeQuoteInput,
  type ClaudiumViewInput,
  claudiumRailOptions,
  formatQuoteCountdown,
  scaleBaseUnits,
} from '../src/ui/claudium_view';

// The pure Claudium view core is DOM/i18n/net-free, so it drives directly here.
// Two states matter: a funded state (service on) and the service-off disabled
// state (balance null). The core recomputes NOTHING; it only projects the
// service payloads into render rows + per-rail availability.

const funded: ClaudiumViewInput = {
  balance: 1250,
  skus: [
    { sku: 's1', usd: 1, claudium: 100 },
    { sku: 's10', usd: 10, claudium: 1000 },
    { sku: 's100', usd: 100, claudium: 10000 },
  ],
  price: { usdPerClaudium: 0.01, wocBaseUnitsPerClaudium: 42 },
  storeItems: [
    { itemId: 'hat', name: 'Golden Hat', kind: 'cosmetic', costClaudium: 500 },
    { itemId: 'skin', name: 'Ember Skin', kind: 'skin', costClaudium: 2000 },
  ],
};

describe('buildClaudiumView disabled state (service off)', () => {
  it('renders a clean empty state when balance is null, not an error', () => {
    const view = buildClaudiumView({
      balance: null,
      skus: [],
      price: { usdPerClaudium: null, wocBaseUnitsPerClaudium: null },
      storeItems: [],
    });
    expect(view.disabled).toBe(true);
    expect(view.hasBalance).toBe(false);
    expect(view.balance).toBeNull();
    expect(view.buyRows).toEqual([]);
    expect(view.storeRows).toEqual([]);
    expect(view.rails).toEqual({ stripe: false, woc: false });
    expect(view.buyDisabled).toBe(true);
  });

  it('stays disabled even if skus/price somehow arrive with a null balance', () => {
    // A null balance is authoritative: the service is off, so nothing transacts.
    const view = buildClaudiumView({
      balance: null,
      skus: [{ sku: 's1', usd: 1, claudium: 100 }],
      price: { usdPerClaudium: 0.01, wocBaseUnitsPerClaudium: 42 },
      storeItems: [{ itemId: 'hat', name: 'Hat', kind: 'cosmetic', costClaudium: 500 }],
    });
    expect(view.disabled).toBe(true);
    expect(view.buyRows).toEqual([]);
    expect(view.storeRows).toEqual([]);
    expect(view.buyDisabled).toBe(true);
  });
});

describe('buildClaudiumView funded state (service on)', () => {
  it('maps the SKU ladder verbatim into buy rows', () => {
    const view = buildClaudiumView(funded);
    expect(view.disabled).toBe(false);
    expect(view.hasBalance).toBe(true);
    expect(view.balance).toBe(1250);
    expect(view.buyRows).toEqual([
      { sku: 's1', usd: 1, claudium: 100 },
      { sku: 's10', usd: 10, claudium: 1000 },
      { sku: 's100', usd: 100, claudium: 10000 },
    ]);
  });

  it('maps the store catalog verbatim into store rows', () => {
    const view = buildClaudiumView(funded);
    expect(view.storeRows).toEqual([
      { itemId: 'hat', name: 'Golden Hat', kind: 'cosmetic', costClaudium: 500 },
      { itemId: 'skin', name: 'Ember Skin', kind: 'skin', costClaudium: 2000 },
    ]);
  });

  it('enables both rails when there are skus and the woc oracle price is present', () => {
    const view = buildClaudiumView(funded);
    expect(view.rails).toEqual({ stripe: true, woc: true });
    expect(view.buyDisabled).toBe(false);
  });

  it('disables the woc rail when the oracle price is null (oracle down)', () => {
    const view = buildClaudiumView({
      ...funded,
      price: { usdPerClaudium: 0.01, wocBaseUnitsPerClaudium: null },
    });
    expect(view.rails).toEqual({ stripe: true, woc: false });
    // Stripe still works, so buying is not disabled.
    expect(view.buyDisabled).toBe(false);
  });

  it('disables both rails when there are no skus (stripe needs a rung, woc needs both)', () => {
    const view = buildClaudiumView({ ...funded, skus: [] });
    expect(view.rails).toEqual({ stripe: false, woc: false });
    expect(view.buyDisabled).toBe(true);
    // A zero balance is still a funded (known) state, distinct from the null/off state.
  });

  it('treats a zero balance as a known funded state, not the disabled state', () => {
    const view = buildClaudiumView({ ...funded, balance: 0 });
    expect(view.disabled).toBe(false);
    expect(view.hasBalance).toBe(true);
    expect(view.balance).toBe(0);
  });
});

describe('buildClaudiumView is a pure projection', () => {
  it('returns identical structure for identical input (no hidden state)', () => {
    expect(buildClaudiumView(funded)).toEqual(buildClaudiumView(funded));
  });
});

describe('claudiumRailOptions (four rails: Card + SOL + USDC + WOC)', () => {
  it('lists all four rails in fixed order with the selected one flagged', () => {
    const view = buildClaudiumView(funded);
    const opts = claudiumRailOptions(view, 'sol');
    expect(opts.map((o) => o.id)).toEqual(['stripe', 'sol', 'usdc', 'woc']);
    expect(CLAUDIUM_RAIL_ORDER).toEqual(['stripe', 'sol', 'usdc', 'woc']);
    expect(opts.find((o) => o.id === 'sol')?.selected).toBe(true);
    expect(opts.filter((o) => o.selected)).toHaveLength(1);
  });

  it('enables every rail in a funded state with skus', () => {
    const view = buildClaudiumView(funded);
    const opts = claudiumRailOptions(view, 'stripe');
    expect(opts.every((o) => o.enabled)).toBe(true);
  });

  it('disables all rails when the service is off (disabled view)', () => {
    const view = buildClaudiumView({
      balance: null,
      skus: [],
      price: { usdPerClaudium: null, wocBaseUnitsPerClaudium: null },
      storeItems: [],
    });
    const opts = claudiumRailOptions(view, 'stripe');
    expect(opts.every((o) => !o.enabled)).toBe(true);
  });

  it('disables every rail when there are no skus (nothing to buy)', () => {
    const view = buildClaudiumView({ ...funded, skus: [] });
    const opts = claudiumRailOptions(view, 'sol');
    expect(opts.every((o) => !o.enabled)).toBe(true);
  });
});

describe('scaleBaseUnits (pure base-10 shift of a service integer string)', () => {
  it('scales SOL base units (9 decimals)', () => {
    // 1.5 SOL = 1500000000 lamports.
    expect(scaleBaseUnits('1500000000', 9)).toBe('1.5');
    expect(scaleBaseUnits('1000000000', 9)).toBe('1');
    expect(scaleBaseUnits('250000000', 9)).toBe('0.25');
  });

  it('scales USDC base units (6 decimals) and trims trailing zeros', () => {
    expect(scaleBaseUnits('12500000', 6)).toBe('12.5');
    expect(scaleBaseUnits('12000000', 6)).toBe('12');
  });

  it('handles sub-one amounts with a leading zero whole part', () => {
    expect(scaleBaseUnits('900000', 6)).toBe('0.9');
    expect(scaleBaseUnits('1', 9)).toBe('0.000000001');
  });

  it('returns null (never fabricates) for a malformed base-unit string', () => {
    expect(scaleBaseUnits(null, 9)).toBeNull();
    expect(scaleBaseUnits('12.5', 6)).toBeNull();
    expect(scaleBaseUnits('abc', 6)).toBeNull();
  });
});

const solQuote: ClaudiumNativeQuoteInput = {
  reference: 'ref-sol-1',
  rail: 'sol',
  claudium: 1000,
  amountBase: '1500000000',
  destination: 'So1DestinationAddress1111111111111111111111',
  mint: null,
  memo: 'CLDM:ref-sol-1',
  quoteExpiryMs: 100_000,
  split: null,
  reason: null,
};

describe('buildClaudiumQuotePanel (SOL rail)', () => {
  it('projects the amount, destination, memo, and a live countdown', () => {
    const panel = buildClaudiumQuotePanel('sol', solQuote, 40_000, null);
    expect(panel.disabled).toBe(false);
    expect(panel.decimals).toBe(9);
    expect(panel.amountDisplay).toBe('1.5');
    expect(panel.destination).toBe(solQuote.destination);
    expect(panel.memo).toBe('CLDM:ref-sol-1');
    expect(panel.reference).toBe('ref-sol-1');
    expect(panel.countdownMs).toBe(60_000);
    expect(panel.expired).toBe(false);
    expect(panel.split).toBeNull();
  });

  it('marks the panel expired once now passes the expiry', () => {
    const panel = buildClaudiumQuotePanel('sol', solQuote, 100_001, null);
    expect(panel.countdownMs).toBe(0);
    expect(panel.expired).toBe(true);
  });
});

describe('buildClaudiumQuotePanel (WOC rail split line)', () => {
  const wocQuote: ClaudiumNativeQuoteInput = {
    reference: 'ref-woc-1',
    rail: 'woc',
    claudium: 1000,
    amountBase: '5000000',
    destination: 'WoCTreasuryAddr1111111111111111111111111111',
    mint: 'WoCmint1111111111111111111111111111111111111',
    memo: 'CLDM:ref-woc-1',
    quoteExpiryMs: 90_000,
    split: {
      burnBase: '2500000',
      treasuryBase: '2500000',
      treasury: 'WoCTreasuryAddr1111111111111111111111111111',
    },
    reason: null,
  };

  it('renders the burn/treasury split scaled by the woc decimals from the quote', () => {
    // WOC decimals are not fixed: the consumer resolves them from the quote (6 here).
    const panel = buildClaudiumQuotePanel('woc', wocQuote, 0, 6);
    expect(panel.disabled).toBe(false);
    expect(panel.decimals).toBe(6);
    expect(panel.amountDisplay).toBe('5');
    expect(panel.split).not.toBeNull();
    expect(panel.split?.burnDisplay).toBe('2.5');
    expect(panel.split?.treasuryDisplay).toBe('2.5');
    expect(panel.split?.treasury).toBe(wocQuote.destination);
  });
});

describe('buildClaudiumQuotePanel disabled states (no crash)', () => {
  it('renders disabled for a rail_disabled reason', () => {
    const panel = buildClaudiumQuotePanel(
      'usdc',
      { ...solQuote, rail: 'usdc', reason: 'rail_disabled' },
      0,
      null,
    );
    expect(panel.disabled).toBe(true);
    expect(panel.reason).toBe('rail_disabled');
    expect(panel.amountDisplay).toBeNull();
  });

  it('renders disabled for an oracle_unavailable reason', () => {
    const panel = buildClaudiumQuotePanel(
      'woc',
      { ...solQuote, rail: 'woc', reason: 'oracle_unavailable' },
      0,
      6,
    );
    expect(panel.disabled).toBe(true);
    expect(panel.reason).toBe('oracle_unavailable');
  });

  it('renders disabled (service off) when the quote is null', () => {
    const panel = buildClaudiumQuotePanel('sol', null, 0, null);
    expect(panel.disabled).toBe(true);
    expect(panel.reason).toBe('unavailable');
  });
});

describe('formatQuoteCountdown', () => {
  it('formats remaining ms as mm:ss', () => {
    expect(formatQuoteCountdown(125_000)).toBe('02:05');
    expect(formatQuoteCountdown(9_000)).toBe('00:09');
    expect(formatQuoteCountdown(0)).toBe('00:00');
    expect(formatQuoteCountdown(-500)).toBe('00:00');
  });
});
