// Game-server REST surface for Claudium Staking (Phase 0 scaffolding).
// Spec: docs/prd/woc/claudium-staking.md.
//
// Shape mirrors server/claudium.ts: ONE dispatch core,
// handleClaudiumStakingApi(req, res, accountId), that matches method +
// pathname, computes NOTHING, and always resolves to a typed JSON body. In
// Phase 1 this module gains a RouteDef table registered in
// server/http/registry.ts plus the legacy prefix arm in server/main.ts (the
// dual-edit invariant), and the handlers forward to claudium_proxy siblings.
//
// DELIBERATELY NOT REGISTERED YET: nothing imports this module in Phase 0, so
// shipping it changes no server behavior. Every handler is fail-closed behind
// WOC_CLAUDIUM_STAKING_ENABLED (read lazily per call, like the economy
// proxies, so tests and ops can flip it without a reboot) and returns
// 'not_implemented' for anything that will need the economy service.

import type * as http from 'node:http';
import {
  type ClaudiumStakeTerm,
  stakeTermsWithOverrides,
  termForDays,
} from './claudium_staking_math';
import { json, readBody } from './http_util';

/** Whether the staking feature flag is on (does not imply the service is). */
export function claudiumStakingEnabled(): boolean {
  return process.env.WOC_CLAUDIUM_STAKING_ENABLED === '1';
}

/** The public wire shape of one stakeable term. */
export interface ClaudiumStakingTermView {
  key: string;
  days: number;
  apyBps: number;
}

export interface ClaudiumStakingTermsResult {
  enabled: boolean;
  terms: ClaudiumStakingTermView[];
}

/** Positions are service state; null until Phase 1 wires the proxy. */
export interface ClaudiumStakingPositionsResult {
  positions: null;
  reason: string | null;
}

export interface ClaudiumStakeQuoteResult {
  ok: boolean;
  reference: string | null;
  termDays: number | null;
  amountBase: string | null;
  transactionBase64: string | null;
  reason: string | null;
}

export interface ClaudiumStakeConfirmResult {
  registered: boolean;
  reason: string | null;
}

export interface ClaudiumStakeClaimResult {
  credited: boolean;
  balance: number | null;
  reason: string | null;
}

function disabledReason(): string {
  return claudiumStakingEnabled() ? 'not_implemented' : 'disabled';
}

/**
 * The dispatch core (Phase 0: typed stubs only). Matches the /api/claudium/
 * staking/* family; the account is already resolved by the caller's guard.
 * Never throws: invalid requests resolve to typed invalid/unavailable bodies,
 * so the game stays playable no matter what state the feature is in.
 */
export async function handleClaudiumStakingApi(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  _accountId: number,
): Promise<void> {
  const url = new URL(req.url ?? '/', 'http://localhost');
  const path = url.pathname;

  if (req.method === 'GET' && path === '/api/claudium/staking/terms') {
    const enabled = claudiumStakingEnabled();
    const terms: ClaudiumStakingTermView[] = enabled
      ? stakeTermsWithOverrides(process.env.WOC_CLAUDIUM_STAKE_APY_BPS).map(
          (t: ClaudiumStakeTerm) => ({ key: t.key, days: t.days, apyBps: t.apyBps }),
        )
      : [];
    const body: ClaudiumStakingTermsResult = { enabled, terms };
    return json(res, 200, body);
  }

  if (req.method === 'GET' && path === '/api/claudium/staking/positions') {
    const body: ClaudiumStakingPositionsResult = { positions: null, reason: disabledReason() };
    return json(res, 200, body);
  }

  if (req.method === 'POST' && path === '/api/claudium/staking/stake/quote') {
    const body = (await readBody(req).catch(() => ({}))) as Record<string, unknown>;
    const termDays = Number(body.termDays);
    const amountBase = typeof body.amountBase === 'string' ? body.amountBase : '';
    const owner = typeof body.owner === 'string' ? body.owner : '';
    const invalid =
      !termForDays(termDays) || amountBase === '' || !/^\d+$/.test(amountBase) || owner === '';
    const result: ClaudiumStakeQuoteResult = {
      ok: false,
      reference: null,
      termDays: termForDays(termDays) ? termDays : null,
      amountBase: null,
      transactionBase64: null,
      reason: invalid ? 'invalid_request' : disabledReason(),
    };
    return json(res, 200, result);
  }

  if (req.method === 'POST' && path === '/api/claudium/staking/stake/confirm') {
    const body = (await readBody(req).catch(() => ({}))) as Record<string, unknown>;
    const reference = typeof body.reference === 'string' ? body.reference : '';
    const signature = typeof body.signature === 'string' ? body.signature : '';
    const result: ClaudiumStakeConfirmResult = {
      registered: false,
      reason: reference === '' || signature === '' ? 'invalid_request' : disabledReason(),
    };
    return json(res, 200, result);
  }

  if (req.method === 'POST' && path === '/api/claudium/staking/claim') {
    const body = (await readBody(req).catch(() => ({}))) as Record<string, unknown>;
    const idempotencyKey = typeof body.idempotencyKey === 'string' ? body.idempotencyKey : '';
    const result: ClaudiumStakeClaimResult = {
      credited: false,
      balance: null,
      reason: idempotencyKey === '' ? 'invalid_request' : disabledReason(),
    };
    return json(res, 200, result);
  }

  // An in-family unknown subpath / method (the account is already resolved).
  return json(res, 404, { error: 'unknown endpoint' });
}
