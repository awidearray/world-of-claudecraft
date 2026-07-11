// Typed game-server client for the external merch surface of the economy service.
//
// The merch store sells PHYSICAL goods (Printful dropship) from the homepage. ALL
// money logic lives in the economy service (a separate repo): catalog + prices
// (USD and Claudium per variant), order records, Stripe intents, Solana quotes and
// on-chain verification, Claudium debits, and the Printful integration including
// every shipping address. The game NEVER computes any of it and stores NO merch
// rows and NO PII; this module is the game server's proxy to that service, a
// structural twin of server/claudium_proxy.ts.
//
// GRACEFUL DEGRADATION IS THE CONTRACT. If MERCH_STORE_ENABLED is not '1', or
// WOC_ECONOMY_SERVICE_URL / WOC_ECONOMY_INTERNAL_SECRET is unset, OR the service
// is unreachable / errors / times out, EVERY function here returns a typed
// "unavailable" result (enabled false, empty catalog, checkout refused) and NEVER
// throws up into request handling. The site must render with the store OFF.

const SERVICE_TIMEOUT_MS = 5000;
const NATIVE_CONFIRM_TIMEOUT_MS = 60_000;

export type MerchRail = 'stripe' | 'sol' | 'claudium';

/** One sellable variant of a product (size/color). Both prices come from the service. */
export interface MerchVariant {
  variantId: string;
  label: string;
  usd: number;
  claudium: number;
  inStock: boolean;
}

export interface MerchProduct {
  productId: string;
  name: string;
  description: string;
  imageUrl: string | null;
  variants: MerchVariant[];
}

/** The catalog; enabled:false + empty when the store or the service is off. */
export interface MerchProductsResult {
  enabled: boolean;
  products: MerchProduct[];
}

export interface MerchCartItem {
  variantId: string;
  qty: number;
}

/**
 * The shipping address, forwarded to the service ONCE at checkout and never
 * stored or logged game-side (the service owns fulfillment PII).
 */
export interface MerchShipping {
  name: string;
  address1: string;
  address2: string;
  city: string;
  state: string;
  zip: string;
  country: string;
}

/** The stripe-rail intent leg (client uses clientSecret with Stripe.js). */
export interface MerchStripeIntent {
  clientSecret: string;
  publishableKey: string;
}

/** The sol-rail intent leg: the pre-built transfer the client wallet signs. */
export interface MerchNativeIntent {
  reference: string;
  amountBase: string;
  destination: string;
  mint: string | null;
  memo: string | null;
  quoteExpiryMs: number | null;
  transactionBase64: string;
}

export interface MerchCheckoutResult {
  ok: boolean;
  orderId: string | null;
  rail: MerchRail | null;
  totalUsd: number | null;
  totalClaudium: number | null;
  stripe: MerchStripeIntent | null;
  native: MerchNativeIntent | null;
  /** True only on the claudium rail, which settles synchronously in this call. */
  paid: boolean;
  /** The remaining Claudium balance after a synchronous claudium-rail settle. */
  balance: number | null;
  reason: string | null;
}

export interface MerchNativeConfirmResult {
  settled: boolean;
  orderId: string | null;
  reason: string | null;
}

/** A PII-light order reference: status + item names + tracking, nothing more. */
export interface MerchOrder {
  orderId: string;
  status: string;
  createdAtMs: number;
  totalLabel: string;
  items: { name: string; qty: number }[];
  trackingUrl: string | null;
}

export interface MerchOrdersResult {
  orders: MerchOrder[];
}

export interface MerchWebhookResult {
  received: boolean;
}

function serviceUrl(): string {
  return (process.env.WOC_ECONOMY_SERVICE_URL ?? '').trim();
}

function serviceSecret(): string {
  return process.env.WOC_ECONOMY_INTERNAL_SECRET ?? '';
}

/**
 * The merch store is reachable only when the explicit kill switch is on AND the
 * economy-service env pair is set (the same URL + secret the Claudium surface
 * uses; merch is another surface of the same internal service).
 */
export function merchServiceConfigured(): boolean {
  return process.env.MERCH_STORE_ENABLED === '1' && serviceUrl() !== '' && serviceSecret() !== '';
}

let loggedOnce = false;
function logFailure(err: unknown): void {
  // Dev-channel only; the request path never sees this. Log once so a persistently
  // down service does not flood the server log every request.
  if (loggedOnce) return;
  loggedOnce = true;
  const message = err instanceof Error ? err.message : String(err);
  console.warn(`[merch] economy service unavailable: ${message}`);
}

interface ServiceRequest {
  method: 'GET' | 'POST';
  path: string;
  body?: unknown;
  timeoutMs?: number;
}

/**
 * The one fetch wrapper. Returns the parsed JSON on a 2xx, or null on any
 * failure (unconfigured, non-2xx, network error, timeout, bad JSON). It NEVER
 * throws: every caller maps a null into its own typed unavailable result.
 */
async function callService<T>(req: ServiceRequest): Promise<T | null> {
  if (!merchServiceConfigured()) return null;
  try {
    const base = serviceUrl();
    const url = new URL(req.path.replace(/^\//, ''), base.endsWith('/') ? base : `${base}/`);
    const headers: Record<string, string> = { 'x-woc-economy-secret': serviceSecret() };
    let body: string | undefined;
    if (req.body !== undefined) {
      headers['Content-Type'] = 'application/json';
      body = JSON.stringify(req.body);
    }
    const res = await fetch(url, {
      method: req.method,
      headers,
      body,
      signal: AbortSignal.timeout(req.timeoutMs ?? SERVICE_TIMEOUT_MS),
    });
    if (!res.ok) throw new Error(`${req.method} ${req.path} -> ${res.status}`);
    return (await res.json()) as T;
  } catch (err) {
    logFailure(err);
    return null;
  }
}

/**
 * Relay a provider webhook raw to the service, which owns signature verification
 * (the service is not publicly reachable, so providers point at the game host).
 * Mirrors claudiumStripeWebhook: a service 400 (bad signature) passes through as
 * received:false rather than counting as an outage.
 */
async function relayWebhook(
  path: string,
  rawBody: Buffer,
  signatureHeader: string,
  headerName: string,
): Promise<MerchWebhookResult> {
  if (!merchServiceConfigured()) return { received: false };
  try {
    const base = serviceUrl();
    const url = new URL(path, base.endsWith('/') ? base : `${base}/`);
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-woc-economy-secret': serviceSecret(),
        [headerName]: signatureHeader,
      },
      body: new Uint8Array(rawBody),
      signal: AbortSignal.timeout(SERVICE_TIMEOUT_MS),
    });
    if (!res.ok && res.status !== 400) throw new Error(`POST ${path} -> ${res.status}`);
    const data = (await res.json()) as { received?: unknown };
    return { received: data.received === true };
  } catch (err) {
    logFailure(err);
    return { received: false };
  }
}

export function merchStripeWebhook(
  rawBody: Buffer,
  signatureHeader: string,
): Promise<MerchWebhookResult> {
  return relayWebhook('merch/stripe/webhook', rawBody, signatureHeader, 'stripe-signature');
}

export function merchPrintfulWebhook(
  rawBody: Buffer,
  signatureHeader: string,
): Promise<MerchWebhookResult> {
  return relayWebhook('merch/printful/webhook', rawBody, signatureHeader, 'x-pf-webhook-signature');
}

/** GET merch/products. enabled:false + empty catalog when the store is off. */
export async function merchProducts(): Promise<MerchProductsResult> {
  const data = await callService<{ enabled?: unknown; products?: unknown }>({
    method: 'GET',
    path: 'merch/products',
  });
  if (!data || data.enabled !== true || !Array.isArray(data.products)) {
    return { enabled: false, products: [] };
  }
  const products = (data.products as MerchProduct[]).filter(
    (p): p is MerchProduct =>
      typeof p?.productId === 'string' &&
      typeof p.name === 'string' &&
      Array.isArray(p.variants) &&
      p.variants.every(
        (v) =>
          typeof v?.variantId === 'string' &&
          typeof v.label === 'string' &&
          typeof v.usd === 'number' &&
          typeof v.claudium === 'number' &&
          typeof v.inStock === 'boolean',
      ),
  );
  return {
    enabled: true,
    products: products.map((p) => ({
      productId: p.productId,
      name: p.name,
      description: typeof p.description === 'string' ? p.description : '',
      imageUrl: typeof p.imageUrl === 'string' ? p.imageUrl : null,
      variants: p.variants,
    })),
  };
}

const OFF_CHECKOUT: MerchCheckoutResult = {
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

/** POST merch/checkout. ok:false with a reason when the store is off. */
export async function merchCheckout(input: {
  accountId: string;
  rail: MerchRail;
  items: MerchCartItem[];
  shipping: MerchShipping;
  email: string;
  idempotencyKey: string;
  payer?: string;
}): Promise<MerchCheckoutResult> {
  const data = await callService<{
    orderId?: string;
    rail?: MerchRail;
    totalUsd?: number;
    totalClaudium?: number;
    stripe?: MerchStripeIntent;
    native?: MerchNativeIntent;
    paid?: boolean;
    balance?: number;
    reason?: string;
  }>({ method: 'POST', path: 'merch/checkout', body: input });
  if (!data?.orderId) {
    return { ...OFF_CHECKOUT, reason: data?.reason ?? 'unavailable' };
  }
  return {
    ok: true,
    orderId: data.orderId,
    rail: data.rail ?? input.rail,
    totalUsd: typeof data.totalUsd === 'number' ? data.totalUsd : null,
    totalClaudium: typeof data.totalClaudium === 'number' ? data.totalClaudium : null,
    stripe: data.stripe ?? null,
    native: data.native ?? null,
    paid: data.paid === true,
    balance: typeof data.balance === 'number' ? data.balance : null,
    reason: data.reason ?? null,
  };
}

/** POST merch/checkout/native/confirm. settled:false when the store is off. */
export async function merchNativeConfirm(input: {
  reference: string;
  signature: string;
}): Promise<MerchNativeConfirmResult> {
  const data = await callService<{ settled?: boolean; orderId?: string; reason?: string }>({
    method: 'POST',
    path: 'merch/checkout/native/confirm',
    body: input,
    timeoutMs: NATIVE_CONFIRM_TIMEOUT_MS,
  });
  if (!data) return { settled: false, orderId: null, reason: 'unavailable' };
  return {
    settled: data.settled === true,
    orderId: typeof data.orderId === 'string' ? data.orderId : null,
    reason: data.reason ?? null,
  };
}

/** GET merch/orders/:accountId. Empty when the store is off. */
export async function merchOrders(accountId: string): Promise<MerchOrdersResult> {
  const data = await callService<{ orders?: unknown }>({
    method: 'GET',
    path: `merch/orders/${encodeURIComponent(accountId)}`,
  });
  if (!data || !Array.isArray(data.orders)) return { orders: [] };
  const orders = (data.orders as MerchOrder[]).filter(
    (o): o is MerchOrder =>
      typeof o?.orderId === 'string' &&
      typeof o.status === 'string' &&
      typeof o.createdAtMs === 'number' &&
      Array.isArray(o.items),
  );
  return {
    orders: orders.map((o) => ({
      orderId: o.orderId,
      status: o.status,
      createdAtMs: o.createdAtMs,
      totalLabel: typeof o.totalLabel === 'string' ? o.totalLabel : '',
      items: o.items.filter((i) => typeof i?.name === 'string' && typeof i.qty === 'number'),
      trackingUrl: typeof o.trackingUrl === 'string' ? o.trackingUrl : null,
    })),
  };
}
