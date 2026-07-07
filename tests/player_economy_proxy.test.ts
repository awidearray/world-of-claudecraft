// The graceful-degradation contract for server/player_economy_proxy.ts (#923):
// with the economy service UNCONFIGURED (or unreachable), every proxy function
// returns a typed "unavailable" result and NEVER throws. This is what lets the
// game boot and play with the service OFF. We prove both halves: the
// unconfigured path (no env), and the configured-but-unreachable path (a
// mocked fetch that rejects). No real network is touched.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as proxy from '../server/player_economy_proxy';

const ENV_KEYS = ['WOC_ECONOMY_SERVICE_URL', 'WOC_ECONOMY_INTERNAL_SECRET'] as const;
const saved: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const k of ENV_KEYS) saved[k] = process.env[k];
});
afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  vi.restoreAllMocks();
});

function clearEnv(): void {
  for (const k of ENV_KEYS) delete process.env[k];
}

describe('player-economy proxy: unconfigured (service OFF)', () => {
  beforeEach(clearEnv);

  it('reports the service as not configured', () => {
    expect(proxy.playerEconomyServiceConfigured()).toBe(false);
  });

  it('tipQuote returns a typed unavailable result, never throws', async () => {
    const r = await proxy.tipQuote({
      fromAccountId: 1,
      toAccountId: 2,
      amountBase: '1000000',
      toWallet: 'RCPT',
    });
    expect(r.ok).toBe(false);
    expect(r.memo).toBeNull();
    expect(r.destination).toBeNull();
    expect(r.amountBase).toBeNull();
    expect(r.reason).toBe('unavailable');
  });

  it('tipConfirm returns settled:false unavailable, never throws', async () => {
    const r = await proxy.tipConfirm({
      fromAccountId: 1,
      toAccountId: 2,
      amountBase: '1000000',
      signature: 'SIG',
      memo: 'TIP_x',
    });
    expect(r.settled).toBe(false);
    expect(r.reason).toBe('unavailable');
  });

  it('jobQuote returns ok:false unavailable, never throws', async () => {
    const r = await proxy.jobQuote({
      employerAccountId: 10,
      guardAccountId: 20,
      role: 'bodyguard',
      amountBase: '1000000',
      durationMs: 600000,
      escrow: { jobIdNum: '1720000000001', handle: 'So11111111111111111111111111111111111111112' },
    });
    expect(r.ok).toBe(false);
    expect(r.jobId).toBeNull();
    expect(r.escrow).toBeNull();
    expect(r.reason).toBe('unavailable');
  });

  it('jobConfirm returns funded:false unavailable, never throws', async () => {
    const r = await proxy.jobConfirm({ jobId: 'job_1', signature: 'SIG' });
    expect(r.funded).toBe(false);
    expect(r.reason).toBe('unavailable');
  });

  it('jobStatus returns the unavailable status, never throws', async () => {
    const r = await proxy.jobStatus('job_1');
    expect(r.status).toBe('unavailable');
    expect(r.amountBase).toBe('0');
  });

  it('jobs returns an empty list, never throws', async () => {
    const r = await proxy.jobs(10);
    expect(Array.isArray(r)).toBe(true);
    expect(r.length).toBe(0);
  });
});

describe('player-economy proxy: configured but unreachable', () => {
  beforeEach(() => {
    process.env.WOC_ECONOMY_SERVICE_URL = 'http://economy-service.invalid:8798';
    process.env.WOC_ECONOMY_INTERNAL_SECRET = 'test-secret';
    // A fetch that always rejects models a down/timed-out service.
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('ECONNREFUSED');
      }),
    );
  });

  it('reports configured, but still degrades gracefully on a network error', async () => {
    expect(proxy.playerEconomyServiceConfigured()).toBe(true);
    const tip = await proxy.tipQuote({
      fromAccountId: 1,
      toAccountId: 2,
      amountBase: '1000000',
      toWallet: 'RCPT',
    });
    expect(tip.ok).toBe(false);
    expect(tip.reason).toBe('unavailable');
    const job = await proxy.jobConfirm({ jobId: 'job_1', signature: 'SIG' });
    expect(job.funded).toBe(false);
    expect(job.reason).toBe('unavailable');
    const status = await proxy.jobStatus('job_1');
    expect(status.status).toBe('unavailable');
  });

  it('degrades gracefully on a non-2xx response (never throws)', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('nope', { status: 503 })),
    );
    const r = await proxy.jobQuote({
      employerAccountId: 10,
      guardAccountId: 20,
      role: 'bodyguard',
      amountBase: '1000000',
      durationMs: 600000,
      escrow: { jobIdNum: '1720000000002', handle: 'So11111111111111111111111111111111111111112' },
    });
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('unavailable');
  });
});
