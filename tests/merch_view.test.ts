// Coverage for the pure merch-store view core (src/ui/merch_view.ts): the
// disabled state, catalog/cart projection, the display-only totals, rail gating,
// and the forward-compatible order-status mapping. DOM-free and i18n-free by
// construction; this drives it directly.

import { describe, expect, it } from 'vitest';
import {
  buildMerchView,
  type MerchProductInput,
  type MerchViewInput,
  merchStatusKey,
} from '../src/ui/merch_view';

const TEE: MerchProductInput = {
  productId: 'tee',
  name: 'Claudemoon Tee',
  description: 'Soft cotton.',
  imageUrl: null,
  variants: [
    { variantId: 'tee-m', label: 'M', usd: 24.99, claudium: 2499, inStock: true },
    { variantId: 'tee-l', label: 'L', usd: 24.99, claudium: 2499, inStock: false },
  ],
};

const MUG: MerchProductInput = {
  productId: 'mug',
  name: 'Guild Mug',
  description: 'Holds coffee.',
  imageUrl: 'https://cdn.test/mug.png',
  variants: [{ variantId: 'mug-std', label: 'Standard', usd: 14.5, claudium: 1450, inStock: true }],
};

function input(overrides: Partial<MerchViewInput> = {}): MerchViewInput {
  return {
    enabled: true,
    products: [TEE, MUG],
    claudiumBalance: null,
    cart: [],
    ...overrides,
  };
}

describe('disabled state', () => {
  it('renders a clean empty model when the store is off', () => {
    const view = buildMerchView(input({ enabled: false, cart: [{ variantId: 'tee-m', qty: 1 }] }));
    expect(view.disabled).toBe(true);
    expect(view.productRows).toEqual([]);
    expect(view.cartRows).toEqual([]);
    expect(view.rails).toEqual({ stripe: false, sol: false, claudium: false });
    expect(view.canCheckout).toBe(false);
  });
});

describe('catalog + cart projection', () => {
  it('mirrors the catalog verbatim and joins the cart onto known variants', () => {
    const view = buildMerchView(
      input({
        cart: [
          { variantId: 'tee-m', qty: 2 },
          { variantId: 'mug-std', qty: 1 },
          { variantId: 'gone', qty: 3 }, // unknown variant: dropped, never guessed
          { variantId: 'tee-l', qty: 0 }, // non-positive qty: dropped
        ],
      }),
    );
    expect(view.disabled).toBe(false);
    expect(view.productRows).toHaveLength(2);
    expect(view.cartRows.map((r) => r.variantId)).toEqual(['tee-m', 'mug-std']);
    expect(view.cartRows[0]).toMatchObject({
      productName: 'Claudemoon Tee',
      variantLabel: 'M',
      qty: 2,
      lineUsd: 49.98,
      lineClaudium: 4998,
    });
    expect(view.cartCount).toBe(3);
    expect(view.totalUsd).toBeCloseTo(64.48, 2);
    expect(view.totalClaudium).toBe(6448);
  });

  it('blocks checkout while the cart holds an out-of-stock variant', () => {
    const view = buildMerchView(input({ cart: [{ variantId: 'tee-l', qty: 1 }] }));
    expect(view.cartRows).toHaveLength(1);
    expect(view.canCheckout).toBe(false);
    expect(view.rails).toEqual({ stripe: false, sol: false, claudium: false });
  });
});

describe('rail availability', () => {
  it('needs a checkout-able cart for stripe/sol and a covering balance for claudium', () => {
    const empty = buildMerchView(input({ claudiumBalance: 100_000 }));
    expect(empty.rails).toEqual({ stripe: false, sol: false, claudium: false });

    const cart = [{ variantId: 'mug-std', qty: 1 }];
    const noBalance = buildMerchView(input({ cart }));
    expect(noBalance.rails).toEqual({ stripe: true, sol: true, claudium: false });

    const short = buildMerchView(input({ cart, claudiumBalance: 1449 }));
    expect(short.rails.claudium).toBe(false);

    const funded = buildMerchView(input({ cart, claudiumBalance: 1450 }));
    expect(funded.rails).toEqual({ stripe: true, sol: true, claudium: true });
  });
});

describe('order rows', () => {
  it('maps known statuses to their label keys and unknown ones to unknown', () => {
    expect(merchStatusKey('pending_payment')).toBe('pendingPayment');
    expect(merchStatusKey('in_production')).toBe('inProduction');
    expect(merchStatusKey('fulfillment_failed')).toBe('fulfillmentFailed');
    expect(merchStatusKey('teleported_to_moon')).toBe('unknown');

    const view = buildMerchView(
      input({
        orders: [
          {
            orderId: 'ord_1',
            status: 'shipped',
            createdAtMs: 1_700_000_000_000,
            totalLabel: '$24.99',
            items: [
              { name: 'Claudemoon Tee', qty: 1 },
              { name: 'Guild Mug', qty: 2 },
            ],
            trackingUrl: 'https://track.test/1',
          },
          {
            orderId: 'ord_2',
            status: 'some_future_status',
            createdAtMs: 1_700_000_100_000,
            totalLabel: '1450 Claudium',
            items: [],
            trackingUrl: null,
          },
        ],
      }),
    );
    expect(view.orderRows[0]).toMatchObject({
      orderId: 'ord_1',
      statusKey: 'shipped',
      itemsLabel: 'Claudemoon Tee x1, Guild Mug x2',
      trackingUrl: 'https://track.test/1',
    });
    expect(view.orderRows[1].statusKey).toBe('unknown');
  });
});
