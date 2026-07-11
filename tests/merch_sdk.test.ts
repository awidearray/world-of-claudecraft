// Coverage for the merch client SDK (src/net/merch_sdk.ts): the tokenless public
// catalog read, the typed OFF fallbacks for authed calls, and the checkout
// orchestrator's stop-clean seams (no signer / store off => nothing charged),
// mirroring tests/economy_sdk.test.ts.

import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  type MerchCheckout,
  type MerchCheckoutClient,
  MerchClient,
  type MerchShipping,
  startMerchCheckout,
} from '../src/net/merch_sdk';

const SHIPPING: MerchShipping = {
  name: 'Alice Example',
  address1: '1 Claudemoon Way',
  address2: '',
  city: 'Valeholm',
  state: '',
  zip: '00001',
  country: 'US',
};

function checkoutInput(rail: 'stripe' | 'sol' | 'claudium') {
  return {
    rail,
    items: [{ variantId: 'tee-m', qty: 1 }],
    shipping: SHIPPING,
    email: 'alice@example.com',
  };
}

function okCheckout(overrides: Partial<MerchCheckout> = {}): MerchCheckout {
  return {
    ok: true,
    orderId: 'ord_1',
    rail: 'stripe',
    totalUsd: 24.99,
    totalClaudium: 2499,
    stripe: null,
    native: null,
    paid: false,
    balance: null,
    reason: null,
    ...overrides,
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('MerchClient', () => {
  it('reads the public catalog without a token (no Authorization header)', async () => {
    const fetchSpy = vi.fn(
      async () => new Response(JSON.stringify({ enabled: true, products: [] }), { status: 200 }),
    );
    vi.stubGlobal('fetch', fetchSpy);
    const client = new MerchClient({ token: () => null });

    const result = await client.products();
    expect(result).toEqual({ enabled: true, products: [] });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect((init.headers as Record<string, string>).Authorization).toBeUndefined();
  });

  it('resolves authed calls to their OFF fallbacks without a token (no fetch)', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    const client = new MerchClient({ token: () => null });

    expect(await client.orders()).toEqual([]);
    expect((await client.checkout({ ...checkoutInput('stripe'), idempotencyKey: 'k' })).ok).toBe(
      false,
    );
    expect(await client.nativeConfirm({ reference: 'r', signature: 's' })).toEqual({
      settled: false,
      orderId: null,
      reason: 'unavailable',
    });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('resolves a network failure to the OFF fallback, never a throw', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('offline');
      }),
    );
    const client = new MerchClient({ token: () => 'tok' });
    expect(await client.products()).toEqual({ enabled: false, products: [] });
    expect(await client.orders()).toEqual([]);
  });
});

describe('startMerchCheckout', () => {
  it('sol rail without a wired signer stops cleanly: nothing fetched, nothing charged', async () => {
    const checkout = vi.fn();
    const client = { checkout, nativeConfirm: vi.fn() } as unknown as MerchCheckoutClient;

    const outcome = await startMerchCheckout(client, checkoutInput('sol'), {});
    expect(outcome.checkout.ok).toBe(false);
    expect(outcome.checkout.reason).toBe('unavailable');
    expect(outcome.settlement).toBeNull();
    expect(checkout).not.toHaveBeenCalled();
  });

  it('stripe rail hands the intent to the stripe signer with the orderId', async () => {
    const intent = { clientSecret: 'cs_test', publishableKey: 'pk_test' };
    const checkout = vi.fn(async () => okCheckout({ stripe: intent }));
    const client = { checkout, nativeConfirm: vi.fn() } as unknown as MerchCheckoutClient;
    const stripe = vi.fn(async () => {});

    const outcome = await startMerchCheckout(client, checkoutInput('stripe'), { stripe });
    expect(outcome.checkout.orderId).toBe('ord_1');
    expect(stripe).toHaveBeenCalledWith(intent, 'ord_1');
    // The orchestrator generated the idempotency key itself.
    const sent = checkout.mock.calls[0][0] as { idempotencyKey: string };
    expect(sent.idempotencyKey).toBeTruthy();
  });

  it('stripe rail without a signer stops after the server intent (seam captured)', async () => {
    const checkout = vi.fn(async () =>
      okCheckout({ stripe: { clientSecret: 'cs', publishableKey: 'pk' } }),
    );
    const client = { checkout, nativeConfirm: vi.fn() } as unknown as MerchCheckoutClient;

    const outcome = await startMerchCheckout(client, checkoutInput('stripe'), {});
    expect(outcome.checkout.ok).toBe(true);
    expect(outcome.settlement).toBeNull();
  });

  it('claudium rail settles synchronously in the checkout call (no signer leg)', async () => {
    const checkout = vi.fn(async () =>
      okCheckout({ rail: 'claudium', paid: true, balance: 1000, stripe: null }),
    );
    const client = { checkout, nativeConfirm: vi.fn() } as unknown as MerchCheckoutClient;

    const outcome = await startMerchCheckout(client, checkoutInput('claudium'), {});
    expect(outcome.checkout.paid).toBe(true);
    expect(outcome.checkout.balance).toBe(1000);
    expect(outcome.settlement).toBeNull();
  });

  it('a store-off checkout passes the typed refusal through unchanged', async () => {
    const off: MerchCheckout = {
      ok: false,
      orderId: null,
      rail: null,
      totalUsd: null,
      totalClaudium: null,
      stripe: null,
      native: null,
      paid: false,
      balance: null,
      reason: 'unavailable',
    };
    const checkout = vi.fn(async () => off);
    const stripe = vi.fn(async () => {});
    const client = { checkout, nativeConfirm: vi.fn() } as unknown as MerchCheckoutClient;

    const outcome = await startMerchCheckout(client, checkoutInput('stripe'), { stripe });
    expect(outcome.checkout).toEqual(off);
    expect(stripe).not.toHaveBeenCalled();
  });
});
