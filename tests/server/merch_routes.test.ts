// Unit coverage for the merch route layer (server/merch.ts).
//
// The merch family registers six RouteDefs the shared dispatcher serves (plus the
// legacy prefix-arm twin in server/main.ts, parity by construction through the
// shared handleMerchApi core):
//   - two public webhook relays (POST /api/merch/{stripe,printful}/webhook);
//   - the public catalog probe (GET /api/merch/products);
//   - the bearer-gated player trio (POST /api/merch/checkout,
//     POST /api/merch/checkout/native/confirm, GET /api/merch/orders), each gated
//     by the shared legacy-body activeGuard (createActiveGuard over the lazy
//     guard db).
//
// Everything downstream is the fail-closed merch_proxy: with MERCH_STORE_ENABLED
// unset every handler answers its typed unavailable/invalid body, so no fetch and
// no Postgres is ever touched here.
//
// server/db builds a pg Pool at module load and throws if DATABASE_URL is unset;
// a dummy URL is set before the module graph evaluates. The pool never connects:
// the guard reads go through setMerchDbForTests.
process.env.DATABASE_URL ||= 'postgres://test:test@127.0.0.1:5433/wocc_merch_routes';

import type * as http from 'node:http';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AccountModerationStatus } from '../../server/db';
import { compose } from '../../server/http/compose';
import { withErrors } from '../../server/http/middleware/with_errors';
import type { Method, Middleware } from '../../server/http/types';
import { resetMerchDbForTests, routes, setMerchDbForTests } from '../../server/merch';
import { type FakeRes, fakeCtx } from './helpers';

// A well-formed bearer header (64 lowercase-hex, matching the guard BEARER_PATTERN).
const BEARER = `Bearer ${'a'.repeat(64)}`;

const PUBLIC_PATHS: ReadonlyArray<readonly [Method, string]> = [
  ['POST', '/api/merch/stripe/webhook'],
  ['POST', '/api/merch/printful/webhook'],
  ['GET', '/api/merch/products'],
];
const PLAYER_PATHS: ReadonlyArray<readonly [Method, string]> = [
  ['POST', '/api/merch/checkout'],
  ['POST', '/api/merch/checkout/native/confirm'],
  ['GET', '/api/merch/orders'],
];

const VALID_CHECKOUT_BODY = {
  rail: 'stripe',
  items: [{ variantId: 'tee-m', qty: 1 }],
  shipping: {
    name: 'Alice Example',
    address1: '1 Claudemoon Way',
    city: 'Valeholm',
    zip: '00001',
    country: 'US',
  },
  email: 'alice@example.com',
  idempotencyKey: 'idem-1',
};

/** A not-locked AccountModerationStatus (the guard bundle's real return shape). */
function modStatus(overrides: Partial<AccountModerationStatus> = {}): AccountModerationStatus {
  return {
    locked: false,
    banned: false,
    suspendedUntil: null,
    reason: '',
    message: '',
    chatMutedUntil: null,
    chatStrikes: 0,
    ...overrides,
  };
}

/** Authorize the shared guard db with a full, non-locked account (overridable). */
function authedDb(overrides: Partial<Parameters<typeof setMerchDbForTests>[0]> = {}): void {
  setMerchDbForTests({
    accountAndScopeForToken: async () => ({ accountId: 7, scope: 'full' }),
    moderationStatusForAccount: async () => modStatus(),
    ...overrides,
  });
}

/** Read status/body off the fakeCtx's FakeRes. */
function readRes(res: http.ServerResponse): { status: number; body: unknown } {
  const fake = res as unknown as FakeRes;
  let body: unknown;
  try {
    body = fake.body ? JSON.parse(fake.body) : undefined;
  } catch {
    body = undefined;
  }
  return { status: fake.statusCode, body };
}

/** Grab a route by method + path. */
function routeFor(method: Method, path: string) {
  const route = routes.find((r) => r.method === method && r.path === path);
  if (!route) throw new Error(`no route ${method} ${path}`);
  return route;
}

/** Drive a full route chain (its real guard middleware + handler) under withErrors. */
async function runRoute(
  method: Method,
  path: string,
  opts: { body?: unknown; headers?: Record<string, string> } = {},
) {
  const route = routeFor(method, path);
  let reached = false;
  const terminal: Middleware = async (c) => {
    reached = true;
    await route.handler(c);
  };
  const ctx = fakeCtx({ method, url: path, headers: opts.headers, body: opts.body });
  const stack: Middleware[] = [
    withErrors({ surface: route.meta?.envelope }),
    ...(route.middleware ?? []),
    terminal,
  ];
  await compose(stack)(ctx);
  return { reached, ...readRes(ctx.res) };
}

const ENV_KEYS = [
  'MERCH_STORE_ENABLED',
  'WOC_ECONOMY_SERVICE_URL',
  'WOC_ECONOMY_INTERNAL_SECRET',
] as const;
const ORIGINAL_ENV = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));

beforeEach(() => {
  // The store env stays unset: every proxy read fails closed, so no fetch and no
  // network dependency anywhere in this suite.
  for (const key of ENV_KEYS) delete process.env[key];
  resetMerchDbForTests();
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    const original = ORIGINAL_ENV[key];
    if (original === undefined) delete process.env[key];
    else process.env[key] = original;
  }
  resetMerchDbForTests();
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// 1. The route table shape.
// ---------------------------------------------------------------------------

describe('merch route table', () => {
  it('registers exactly the six routes in the declared order', () => {
    expect(routes.map((r) => `${r.method} ${r.path}`)).toEqual([
      'POST /api/merch/stripe/webhook',
      'POST /api/merch/printful/webhook',
      'GET /api/merch/products',
      'POST /api/merch/checkout',
      'POST /api/merch/checkout/native/confirm',
      'GET /api/merch/orders',
    ]);
  });

  it('marks the public routes publicRead with NO middleware', () => {
    for (const [method, path] of PUBLIC_PATHS) {
      const r = routeFor(method, path);
      expect(r.surface, path).toBe('api');
      expect(r.meta?.publicRead, path).toBe(true);
      expect(r.middleware, path).toBeUndefined();
    }
  });

  it('mounts ONE shared activeGuard instance across the player trio', () => {
    const guards = new Set(PLAYER_PATHS.map(([m, p]) => routeFor(m, p).middleware?.[0]));
    expect(guards.size).toBe(1);
    expect([...guards][0]).toBeDefined();
    for (const [method, path] of PLAYER_PATHS) {
      const r = routeFor(method, path);
      expect(r.surface, path).toBe('api');
      expect(Array.isArray(r.middleware) && r.middleware.length === 1, path).toBe(true);
      expect(r.schema, path).toBeUndefined();
    }
  });
});

// ---------------------------------------------------------------------------
// 2. The player routes authenticate through the REAL shared activeGuard chain.
// ---------------------------------------------------------------------------

describe('player routes: activeGuard chain', () => {
  for (const [method, path] of PLAYER_PATHS) {
    it(`${method} ${path} 401s a missing bearer, handler never called`, async () => {
      authedDb();
      const r = await runRoute(method, path);
      expect(r.status).toBe(401);
      expect(r.body).toEqual({ error: 'not authenticated', code: 'auth.required' });
      expect(r.reached).toBe(false);
    });
  }

  it('403s a read-only token', async () => {
    authedDb({ accountAndScopeForToken: async () => ({ accountId: 7, scope: 'read' }) });
    const r = await runRoute('GET', '/api/merch/orders', { headers: { authorization: BEARER } });
    expect(r.status).toBe(403);
    expect(r.body).toEqual({ error: 'this token is read-only', code: 'auth.forbidden' });
    expect(r.reached).toBe(false);
  });

  it('403s a moderation-locked account with the status message', async () => {
    authedDb({
      moderationStatusForAccount: async () =>
        modStatus({ locked: true, message: 'this account is suspended.' }),
    });
    const r = await runRoute('POST', '/api/merch/checkout', {
      headers: { authorization: BEARER },
      body: VALID_CHECKOUT_BODY,
    });
    expect(r.status).toBe(403);
    expect(r.body).toEqual({ error: 'this account is suspended.', code: 'moderation.suspended' });
    expect(r.reached).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 3. The handlers answer typed bodies (store off = fail closed, never a throw).
// ---------------------------------------------------------------------------

describe('handlers: typed fail-closed bodies with the store off', () => {
  beforeEach(() => {
    authedDb();
  });

  it('GET /api/merch/products answers 200 { enabled:false, products:[] } logged out', async () => {
    const r = await runRoute('GET', '/api/merch/products');
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ enabled: false, products: [] });
    expect(r.reached).toBe(true);
  });

  it('POST checkout with an invalid body answers 200 reason invalid_request', async () => {
    const r = await runRoute('POST', '/api/merch/checkout', {
      headers: { authorization: BEARER },
      body: { rail: 'paypal', items: [] },
    });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ ok: false, orderId: null, reason: 'invalid_request' });
    expect(r.reached).toBe(true);
  });

  it('POST checkout on the sol rail without a payer is invalid_request', async () => {
    const r = await runRoute('POST', '/api/merch/checkout', {
      headers: { authorization: BEARER },
      body: { ...VALID_CHECKOUT_BODY, rail: 'sol' },
    });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ ok: false, reason: 'invalid_request' });
  });

  it('POST checkout with a valid body answers 200 reason unavailable (proxy off)', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    const r = await runRoute('POST', '/api/merch/checkout', {
      headers: { authorization: BEARER },
      body: VALID_CHECKOUT_BODY,
    });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ ok: false, orderId: null, paid: false, reason: 'unavailable' });
    expect(fetchSpy).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });

  it('POST native/confirm with a bad body answers 200 invalid_request; valid answers unavailable', async () => {
    const bad = await runRoute('POST', '/api/merch/checkout/native/confirm', {
      headers: { authorization: BEARER },
      body: { reference: '' },
    });
    expect(bad.status).toBe(200);
    expect(bad.body).toEqual({ settled: false, orderId: null, reason: 'invalid_request' });

    const ok = await runRoute('POST', '/api/merch/checkout/native/confirm', {
      headers: { authorization: BEARER },
      body: { reference: 'ref', signature: 'sig' },
    });
    expect(ok.status).toBe(200);
    expect(ok.body).toEqual({ settled: false, orderId: null, reason: 'unavailable' });
  });

  it('GET /api/merch/orders answers 200 { orders: [] }', async () => {
    const r = await runRoute('GET', '/api/merch/orders', {
      headers: { authorization: BEARER },
    });
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ orders: [] });
  });

  it('webhooks are reachable without auth and answer 400 received:false while off', async () => {
    for (const path of ['/api/merch/stripe/webhook', '/api/merch/printful/webhook']) {
      const r = await runRoute('POST', path, { body: { id: 'evt_1' } });
      expect(r.status, path).toBe(400);
      expect(r.body, path).toEqual({ received: false });
      expect(r.reached, path).toBe(true);
    }
  });

  it('an unknown in-family subpath 404s through the shared core', async () => {
    // Drive the shared core through a checkout route ctx with a rewritten url.
    const route = routeFor('POST', '/api/merch/checkout');
    const ctx = fakeCtx({
      method: 'POST',
      url: '/api/merch/refund',
      headers: { authorization: BEARER },
      body: {},
    });
    const stack: Middleware[] = [
      withErrors({ surface: route.meta?.envelope }),
      ...(route.middleware ?? []),
      async (c) => {
        await route.handler(c);
      },
    ];
    await compose(stack)(ctx);
    const r = readRes(ctx.res);
    expect(r.status).toBe(404);
    expect(r.body).toEqual({ error: 'unknown endpoint' });
  });
});
