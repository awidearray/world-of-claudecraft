// Typed game-server client for the external player-economy service (#923).
//
// Player-economy settlement (native TIPS + paid-BODYGUARD job escrow) is
// server-authoritative: ALL amount/finality/destination verification lives in
// the economy service (a separate repo, backed by the job_escrow Anchor program).
// The game NEVER computes or re-verifies any of it; this module is the game
// server's proxy to that service. The browser hits the game server, the game
// server hits the service over a secret-gated internal API. This mirrors
// server/claudium_proxy.ts EXACTLY (thin pass-through, secret-gated, graceful).
//
// GRACEFUL DEGRADATION IS THE CONTRACT. If WOC_ECONOMY_SERVICE_URL or
// WOC_ECONOMY_INTERNAL_SECRET is unset, OR the service is unreachable / errors /
// times out, EVERY function here returns a typed "unavailable" result and NEVER
// throws up into request handling. The game must boot and play with the service
// OFF. The functions mirror the service SDK v1 player_economy surface; they do
// NOT recompute any value, they only pass through what the service returns.

const SERVICE_TIMEOUT_MS = 5000;

// ---- tips -------------------------------------------------------------------

/** A tip quote: the exact transfer the sender's tx must carry. Nulls when off. */
export interface TipQuoteResult {
  ok: boolean;
  memo: string | null; // must appear in the tip tx (service-issued reference)
  destination: string | null; // where the tip must be sent (recipient wallet)
  mint: string | null; // null for native SOL; the $WOC mint otherwise
  amountBase: string | null; // exact base units to send
  expiresAtMs: number | null;
  reason: string | null;
}

/** A tip confirm result. settled:false with a reason when the service is off. */
export interface TipConfirmResult {
  settled: boolean;
  observedAmountBase: string | null;
  reason: string | null;
}

// ---- bodyguard / job escrow -------------------------------------------------

/** A job-escrow quote: the escrow + exact amount + memo for the deposit. */
export interface JobQuoteResult {
  ok: boolean;
  jobId: string | null;
  escrowProgramId: string | null;
  escrow: string | null;
  amountBase: string | null;
  memo: string | null;
  expiresAtMs: number | null;
  reason: string | null;
}

/** A job-escrow deposit confirm result. funded:false + reason when off. */
export interface JobConfirmResult {
  funded: boolean;
  reason: string | null;
}

/** A job's settlement status, as the service mirrors it. status 'not_found' when off. */
export interface JobStatusResult {
  jobId: string;
  status: 'funded' | 'active' | 'completed' | 'refunded' | 'expired' | 'not_found' | 'unavailable';
  amountBase: string;
  employerAccountId: number;
  guardAccountId: number;
  fundedAtMs: number | null;
  settlesAtMs: number | null;
  payoutSignature: string | null;
}

function serviceUrl(): string {
  return (process.env.WOC_ECONOMY_SERVICE_URL ?? '').trim();
}

function serviceSecret(): string {
  return process.env.WOC_ECONOMY_INTERNAL_SECRET ?? '';
}

/** The service is reachable only when BOTH the URL and the secret are set. */
export function playerEconomyServiceConfigured(): boolean {
  return serviceUrl() !== '' && serviceSecret() !== '';
}

let loggedOnce = false;
function logFailure(err: unknown): void {
  // Dev-channel only; the request path never sees this. Log once so a persistently
  // down service does not flood the server log every request.
  if (loggedOnce) return;
  loggedOnce = true;
  const message = err instanceof Error ? err.message : String(err);
  console.warn(`[player-economy] economy service unavailable: ${message}`);
}

interface ServiceRequest {
  method: 'GET' | 'POST';
  path: string;
  body?: unknown;
}

/**
 * The one fetch wrapper. Returns the parsed JSON on a 2xx, or null on any
 * failure (unconfigured, non-2xx, network error, timeout, bad JSON). It NEVER
 * throws: every caller maps a null into its own typed unavailable result.
 */
async function callService<T>(req: ServiceRequest): Promise<T | null> {
  const base = serviceUrl();
  const secret = serviceSecret();
  if (base === '' || secret === '') return null;
  try {
    const url = new URL(req.path.replace(/^\//, ''), base.endsWith('/') ? base : `${base}/`);
    const headers: Record<string, string> = { 'x-woc-economy-secret': secret };
    let body: string | undefined;
    if (req.body !== undefined) {
      headers['Content-Type'] = 'application/json';
      body = JSON.stringify(req.body);
    }
    const res = await fetch(url, {
      method: req.method,
      headers,
      body,
      signal: AbortSignal.timeout(SERVICE_TIMEOUT_MS),
    });
    if (!res.ok) throw new Error(`${req.method} ${req.path} -> ${res.status}`);
    return (await res.json()) as T;
  } catch (err) {
    logFailure(err);
    return null;
  }
}

// ---- tips -------------------------------------------------------------------

/** POST tip/quote. Pins the exact transfer + memo. ok:false when the service is off. */
export async function tipQuote(input: {
  fromAccountId: number;
  toAccountId: number;
  amountBase: string;
  toWallet: string;
}): Promise<TipQuoteResult> {
  const data = await callService<{
    memo: string;
    destination: string;
    mint: string | null;
    amountBase: string;
    expiresAtMs: number;
    reason?: string;
  }>({ method: 'POST', path: 'v1/economy/player-economy/tip/quote', body: input });
  if (!data) {
    return {
      ok: false,
      memo: null,
      destination: null,
      mint: null,
      amountBase: null,
      expiresAtMs: null,
      reason: 'unavailable',
    };
  }
  return {
    ok: !data.reason,
    memo: data.memo || null,
    destination: data.destination || null,
    mint: data.mint ?? null,
    amountBase: data.amountBase || null,
    expiresAtMs: typeof data.expiresAtMs === 'number' ? data.expiresAtMs : null,
    reason: data.reason ?? null,
  };
}

/** POST tip/confirm. Verifies the settled transfer on-chain. settled:false when off. */
export async function tipConfirm(input: {
  fromAccountId: number;
  toAccountId: number;
  amountBase: string;
  signature: string;
  memo: string;
}): Promise<TipConfirmResult> {
  const data = await callService<{
    settled: boolean;
    observedAmountBase?: string;
    reason?: string;
  }>({ method: 'POST', path: 'v1/economy/player-economy/tip/confirm', body: input });
  if (!data) return { settled: false, observedAmountBase: null, reason: 'unavailable' };
  return {
    settled: Boolean(data.settled),
    observedAmountBase: data.observedAmountBase ?? null,
    reason: data.reason ?? null,
  };
}

// ---- bodyguard / job escrow -------------------------------------------------

/**
 * POST job/quote. Registers the escrow with the service and returns the escrow
 * destination + exact amount + memo. ok:false when off.
 *
 * The game derives the job PDA it will deposit to (from a numeric jobId, per the
 * job_escrow seed rule) and passes it as `escrow: { jobIdNum, handle }`. The
 * service re-derives the same PDA and rejects a mismatch, so both sides agree on
 * ONE destination. Without the handle the service rejects an escrow-shaped
 * request (missing_handle).
 */
export async function jobQuote(input: {
  employerAccountId: number;
  guardAccountId: number;
  role: 'bodyguard';
  amountBase: string;
  durationMs: number;
  escrow: { jobIdNum: string; handle: string };
}): Promise<JobQuoteResult> {
  const data = await callService<{
    jobId: string;
    escrowProgramId: string;
    escrow: string;
    amountBase: string;
    memo: string;
    expiresAtMs: number;
    reason?: string;
  }>({ method: 'POST', path: 'v1/economy/player-economy/job/quote', body: input });
  if (!data) {
    return {
      ok: false,
      jobId: null,
      escrowProgramId: null,
      escrow: null,
      amountBase: null,
      memo: null,
      expiresAtMs: null,
      reason: 'unavailable',
    };
  }
  return {
    ok: !data.reason && Boolean(data.jobId),
    jobId: data.jobId || null,
    escrowProgramId: data.escrowProgramId || null,
    escrow: data.escrow || null,
    amountBase: data.amountBase || null,
    memo: data.memo || null,
    expiresAtMs: typeof data.expiresAtMs === 'number' ? data.expiresAtMs : null,
    reason: data.reason ?? null,
  };
}

/** POST job/confirm. Verifies the escrow deposit on-chain. funded:false when off. */
export async function jobConfirm(input: {
  jobId: string;
  signature: string;
}): Promise<JobConfirmResult> {
  const data = await callService<{ funded: boolean; reason?: string }>({
    method: 'POST',
    path: 'v1/economy/player-economy/job/confirm',
    body: input,
  });
  if (!data) return { funded: false, reason: 'unavailable' };
  return { funded: Boolean(data.funded), reason: data.reason ?? null };
}

/** GET job/:jobId. status 'unavailable' when the service is off. */
export async function jobStatus(jobId: string): Promise<JobStatusResult> {
  const data = await callService<JobStatusResult>({
    method: 'GET',
    path: `v1/economy/player-economy/job/${encodeURIComponent(jobId)}`,
  });
  if (!data) {
    return {
      jobId,
      status: 'unavailable',
      amountBase: '0',
      employerAccountId: 0,
      guardAccountId: 0,
      fundedAtMs: null,
      settlesAtMs: null,
      payoutSignature: null,
    };
  }
  return data;
}

/** GET jobs. Empty when the service is off. */
export async function jobs(limit?: number, before?: string): Promise<JobStatusResult[]> {
  const q = new URLSearchParams();
  if (limit !== undefined) q.set('limit', String(limit));
  if (before !== undefined) q.set('before', before);
  const qs = q.toString();
  const data = await callService<JobStatusResult[]>({
    method: 'GET',
    path: `v1/economy/player-economy/jobs${qs ? `?${qs}` : ''}`,
  });
  return Array.isArray(data) ? data : [];
}
