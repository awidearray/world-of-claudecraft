// Client-side typed fetch wrapper for the CLAUDIUM economy surface.
//
// Same-origin only: it talks to the GAME server's /api/claudium/* routes (never
// the economy service directly). Those routes proxy to the service and already
// fail closed, so this layer only has to survive a network hiccup or a logged-out
// caller. It NEVER throws into render: every failure resolves to the same typed
// unavailable state the disabled UI renders (balance null, empty skus/store, buy
// disabled). The client computes NO peg/price/balance; it renders what it gets.

import { apiUrl } from './online';

export type ClaudiumRail = 'stripe' | 'woc';

export interface ClaudiumBalance {
  balance: number | null;
}

export interface ClaudiumPrice {
  rail: string;
  usdPerClaudium: number | null;
  wocBaseUnitsPerClaudium: number | null;
}

export interface ClaudiumSku {
  sku: string;
  usd: number;
  claudium: number;
}

export interface ClaudiumStoreItem {
  itemId: string;
  name: string;
  kind: 'cosmetic' | 'skin' | 'item';
  costClaudium: number;
}

export interface ClaudiumStripeIntent {
  clientSecret: string;
  publishableKey: string;
}

export interface ClaudiumWocIntent {
  amountBase: string;
  burnBase: string;
  treasuryBase: string;
  treasury: string;
  memo: string;
  expiresAtMs: number;
}

export interface ClaudiumPurchase {
  ok: boolean;
  purchaseId: string | null;
  rail: ClaudiumRail | null;
  claudium: number | null;
  stripe: ClaudiumStripeIntent | null;
  woc: ClaudiumWocIntent | null;
  reason: string | null;
}

export interface ClaudiumConfirm {
  credited: boolean;
  balance: number | null;
  reason: string | null;
}

export interface ClaudiumSpend {
  granted: boolean;
  balance: number | null;
  costClaudium: number | null;
  reason: string | null;
}

/** The native Solana settlement rails the economy service now owns. */
export type ClaudiumNativeRail = 'sol' | 'usdc' | 'woc';

/** The fulfillment leg of a native quote. accountId is set server-side for credit. */
export type ClaudiumFulfillment =
  | { kind: 'credit' }
  | { kind: 'giftcard'; recipientEmail?: string; message?: string; deliverAtMs?: number };

/** The WOC split line the service returns (base-unit strings + treasury address). */
export interface ClaudiumNativeSplit {
  burnBase: string;
  treasuryBase: string;
  treasury: string;
}

/**
 * A native-rail quote as the service returns it: the exact crypto amount to send
 * (amountBase, a base-unit string), the destination address, the memo/reference,
 * the quote expiry, and (woc only) the split line. reason is set (and the quote is
 * unusable) when the rail is disabled or the oracle is down; the UI then renders a
 * clean disabled state. The client renders these verbatim, computing nothing.
 */
export interface ClaudiumNativeQuote {
  reference: string | null;
  rail: ClaudiumNativeRail | null;
  claudium: number | null;
  amountBase: string | null;
  destination: string | null;
  mint: string | null;
  memo: string | null;
  quoteExpiryMs: number | null;
  split: ClaudiumNativeSplit | null;
  reason: string | null;
}

/** The native confirm result: settled + the resulting balance or gift-card code. */
export interface ClaudiumNativeConfirm {
  settled: boolean;
  reason: string | null;
  observedAmountBase: string | null;
  fulfillment: { balance: number | null; giftCardCode: string | null } | null;
}

/** The gift-card redeem result: credited amount + resulting balance, or a reason. */
export interface ClaudiumGiftCardRedeem {
  credited: boolean;
  balance: number | null;
  denominationClaudium: number | null;
  reason: string | null;
}

/** The gift-card status lookup result (no account context). */
export interface ClaudiumGiftCardStatus {
  status: 'ACTIVE' | 'REDEEMED' | 'EXPIRED' | 'VOID' | 'not_found';
  denominationClaudium: number | null;
}

/** How the SDK reaches the authed game-server routes: a live token + realm base. */
export interface EconomyClientConfig {
  token(): string | null | undefined;
  base?: string;
}

const OFF_BALANCE: ClaudiumBalance = { balance: null };
const OFF_PRICE = (rail: string): ClaudiumPrice => ({
  rail,
  usdPerClaudium: null,
  wocBaseUnitsPerClaudium: null,
});
const OFF_SKUS: ClaudiumSku[] = [];
const OFF_STORE: ClaudiumStoreItem[] = [];
const OFF_PURCHASE: ClaudiumPurchase = {
  ok: false,
  purchaseId: null,
  rail: null,
  claudium: null,
  stripe: null,
  woc: null,
  reason: 'unavailable',
};
const OFF_CONFIRM: ClaudiumConfirm = { credited: false, balance: null, reason: 'unavailable' };
const OFF_SPEND: ClaudiumSpend = {
  granted: false,
  balance: null,
  costClaudium: null,
  reason: 'unavailable',
};
const OFF_NATIVE_QUOTE: ClaudiumNativeQuote = {
  reference: null,
  rail: null,
  claudium: null,
  amountBase: null,
  destination: null,
  mint: null,
  memo: null,
  quoteExpiryMs: null,
  split: null,
  reason: 'unavailable',
};
const OFF_NATIVE_CONFIRM: ClaudiumNativeConfirm = {
  settled: false,
  reason: 'unavailable',
  observedAmountBase: null,
  fulfillment: null,
};
const OFF_GIFTCARD_REDEEM: ClaudiumGiftCardRedeem = {
  credited: false,
  balance: null,
  denominationClaudium: null,
  reason: 'unavailable',
};
const OFF_GIFTCARD_STATUS: ClaudiumGiftCardStatus = {
  status: 'not_found',
  denominationClaudium: null,
};

export class EconomyClient {
  constructor(private readonly cfg: EconomyClientConfig) {}

  private async get<T>(path: string, fallback: T): Promise<T> {
    const token = this.cfg.token();
    if (!token) return fallback;
    try {
      const res = await fetch(apiUrl(path, this.cfg.base ?? ''), {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!res.ok) return fallback;
      return (await res.json()) as T;
    } catch {
      return fallback;
    }
  }

  private async post<T>(path: string, body: unknown, fallback: T): Promise<T> {
    const token = this.cfg.token();
    if (!token) return fallback;
    try {
      const res = await fetch(apiUrl(path, this.cfg.base ?? ''), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify(body),
      });
      if (!res.ok) return fallback;
      return (await res.json()) as T;
    } catch {
      return fallback;
    }
  }

  balance(): Promise<ClaudiumBalance> {
    return this.get('/api/claudium/balance', OFF_BALANCE);
  }

  price(rail: ClaudiumRail): Promise<ClaudiumPrice> {
    return this.get(`/api/claudium/price/${rail}`, OFF_PRICE(rail));
  }

  skus(): Promise<ClaudiumSku[]> {
    return this.get('/api/claudium/skus', { skus: OFF_SKUS }).then((r) => r.skus ?? OFF_SKUS);
  }

  store(): Promise<ClaudiumStoreItem[]> {
    return this.get('/api/claudium/store', { items: OFF_STORE }).then((r) => r.items ?? OFF_STORE);
  }

  purchase(input: {
    rail: ClaudiumRail;
    sku: string;
    idempotencyKey: string;
  }): Promise<ClaudiumPurchase> {
    return this.post('/api/claudium/purchase', input, OFF_PURCHASE);
  }

  confirmWoc(input: { purchaseId: string; inboundSignature: string }): Promise<ClaudiumConfirm> {
    return this.post('/api/claudium/purchase/woc/confirm', input, OFF_CONFIRM);
  }

  spend(input: {
    itemId: string;
    kind: 'cosmetic' | 'skin' | 'item';
    idempotencyKey: string;
  }): Promise<ClaudiumSpend> {
    return this.post('/api/claudium/spend', input, OFF_SPEND);
  }

  /**
   * Ask the service to quote a native-rail payment. The service returns the exact
   * crypto amount, destination, memo, and expiry; the client renders them and (for
   * a credit fulfillment) later confirms with the on-chain signature.
   */
  nativeQuote(input: {
    rail: ClaudiumNativeRail;
    claudium: number;
    fulfillment: ClaudiumFulfillment;
  }): Promise<ClaudiumNativeQuote> {
    return this.post('/api/claudium/native/quote', input, OFF_NATIVE_QUOTE);
  }

  /** Confirm a native payment by its reference + the on-chain tx signature. */
  nativeConfirm(input: { reference: string; signature: string }): Promise<ClaudiumNativeConfirm> {
    return this.post('/api/claudium/native/confirm', input, OFF_NATIVE_CONFIRM);
  }

  /** Redeem a gift-card code into the caller's balance. */
  redeemGiftCard(input: { code: string }): Promise<ClaudiumGiftCardRedeem> {
    return this.post('/api/claudium/giftcard/redeem', input, OFF_GIFTCARD_REDEEM);
  }

  /** Look up a gift-card's status by code (no account context). */
  giftCardStatus(code: string): Promise<ClaudiumGiftCardStatus> {
    return this.get(
      `/api/claudium/giftcard/status?code=${encodeURIComponent(code)}`,
      OFF_GIFTCARD_STATUS,
    );
  }
}

/** A fresh idempotency key for a purchase/spend attempt (crypto-random, safe to retry). */
export function newIdempotencyKey(): string {
  const c = globalThis.crypto;
  if (c && 'randomUUID' in c) return c.randomUUID();
  return `idem-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

/**
 * Optional client-side signers for the two purchase rails. main.ts passes these
 * once the live integrations exist; until then they are absent and the flow stops
 * cleanly after the server intent (no crash, nothing charged).
 *
 * - stripe: hand the returned clientSecret + publishableKey to Stripe.js and
 *   confirm the PaymentIntent client-side. Needs a live publishable key + Stripe.js.
 * - wocSignAndSend: build + sign the split transfer described by the woc intent
 *   via the Wallet Standard path (the repo's signAndSend), returning the inbound
 *   signature to post to confirmWoc. Needs a live wallet + a built transaction.
 */
export interface ClaudiumSigners {
  stripe?(intent: ClaudiumStripeIntent, purchaseId: string): Promise<void>;
  wocSignAndSend?(intent: ClaudiumWocIntent, purchaseId: string): Promise<string>;
}

/**
 * Orchestrate one purchase end to end: ask the server for the rail-specific intent,
 * then drive the client-side signing seam. This computes NOTHING about price or
 * credit; it only sequences the SDK calls. If the service is off (ok:false) or the
 * needed signer is not wired, it returns without charging anything.
 */
export async function startClaudiumPurchase(
  client: EconomyClient,
  rail: ClaudiumRail,
  sku: string,
  signers: ClaudiumSigners = {},
): Promise<ClaudiumPurchase | ClaudiumConfirm> {
  const purchase = await client.purchase({ rail, sku, idempotencyKey: newIdempotencyKey() });
  if (!purchase.ok || !purchase.purchaseId) return purchase;

  if (rail === 'stripe') {
    // SEAM: the stripe confirmation needs Stripe.js + a live publishable key. When
    // a signer is wired, it confirms the PaymentIntent with the returned
    // clientSecret; otherwise the flow stops here with the server intent captured.
    if (purchase.stripe && signers.stripe) {
      await signers.stripe(purchase.stripe, purchase.purchaseId);
    }
    return purchase;
  }

  // woc rail: sign the split transfer and post the signature to confirm.
  // SEAM: wocSignAndSend needs a live wallet + a built split transaction (the repo
  // Wallet Standard signAndSend path). Without it the flow stops after the intent.
  if (purchase.woc && signers.wocSignAndSend) {
    const inboundSignature = await signers.wocSignAndSend(purchase.woc, purchase.purchaseId);
    return client.confirmWoc({ purchaseId: purchase.purchaseId, inboundSignature });
  }
  return purchase;
}
