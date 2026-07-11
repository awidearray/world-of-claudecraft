// Regulatory hardening (launchpad phase 8, PRD section 10): the IP geo gate
// applied as middleware on every launchpad money route, and the mainnet
// enablement gate that refuses to light a tradeable-token or power-conversion
// surface on a mainnet RPC without the recorded counsel sign-off AND both
// screens (geo + OFAC) enabled. Everything here is flag-gated and DEFAULT OFF:
// the gates exist so the features can only come up mainnet-side with the
// compliance posture in place, never so the features come up by default.
//
// Country resolution reads the edge-stamped country header (Cloudflare's
// CF-IPCountry by default, configurable for other edges). The gate FAILS
// CLOSED while enabled: a request with no resolvable country, an unknown
// country (Cloudflare's XX), or an anonymizer exit (Cloudflare's T1 = Tor) is
// blocked, because "cannot place the request" must never mean "allowed"
// (PRD: never tolerate VPN circumvention by design).

// The OFAC comprehensive-embargo jurisdictions. This is the floor: the env
// list can EXTEND it (retail-restricted jurisdictions counsel adds), never
// shrink it.
export const DEFAULT_BLOCKED_COUNTRIES = ['CU', 'IR', 'KP', 'SY'] as const;

// Cloudflare's non-country sentinels: XX = unknown, T1 = Tor exit. Both are
// blocked while the gate is up (fail-closed on anonymized or unplaceable).
const UNPLACEABLE = new Set(['XX', 'T1']);

export function geoGateEnabled(env: Record<string, string | undefined> = process.env): boolean {
  return (env.REALM_GEO_GATE_ENABLED ?? '').trim() === '1';
}

// The blocked-country set: the embargo floor plus any REALM_GEO_BLOCKED_COUNTRIES
// extensions (comma-separated ISO 3166-1 alpha-2; malformed entries ignored).
export function blockedCountries(
  env: Record<string, string | undefined> = process.env,
): Set<string> {
  const out = new Set<string>(DEFAULT_BLOCKED_COUNTRIES);
  for (const raw of (env.REALM_GEO_BLOCKED_COUNTRIES ?? '').split(',')) {
    const code = raw.trim().toUpperCase();
    if (/^[A-Z]{2}$/.test(code)) out.add(code);
  }
  return out;
}

// The edge header carrying the request country. Node lowercases header names;
// the env override lets a non-Cloudflare edge name its own header.
export function geoCountryHeader(env: Record<string, string | undefined> = process.env): string {
  const raw = (env.REALM_GEO_COUNTRY_HEADER ?? '').trim().toLowerCase();
  return raw !== '' ? raw : 'cf-ipcountry';
}

export function resolveRequestCountry(
  headers: Record<string, string | string[] | undefined>,
  env: Record<string, string | undefined> = process.env,
): string | null {
  const raw = headers[geoCountryHeader(env)];
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (typeof value !== 'string') return null;
  const code = value.trim().toUpperCase();
  return /^[A-Z0-9]{2}$/.test(code) ? code : null;
}

// The middleware check for a launchpad money route. Pass-through while the
// gate is down (the features it protects are themselves dark by default);
// fail-closed while it is up. 451 Unavailable For Legal Reasons is the
// contract status for a region block.
export function geoCheck(
  headers: Record<string, string | string[] | undefined>,
  env: Record<string, string | undefined> = process.env,
): { ok: true } | { ok: false; status: number; error: string } {
  if (!geoGateEnabled(env)) return { ok: true };
  const country = resolveRequestCountry(headers, env);
  if (country === null || UNPLACEABLE.has(country) || blockedCountries(env).has(country)) {
    return { ok: false, status: 451, error: 'region_blocked' };
  }
  return { ok: true };
}

// ── Mainnet enablement gate ──────────────────────────────────────────────────

const MAINNET_RPC = /mainnet/i;

export function isMainnetRpc(rpcUrl: string): boolean {
  return MAINNET_RPC.test(rpcUrl);
}

// The counsel sign-off record: a non-empty reference (memo id + date) that a
// human deliberately sets after the written sign-off exists. Its absence on a
// mainnet RPC hard-disables every gated surface below.
export function counselSignoffRecorded(
  env: Record<string, string | undefined> = process.env,
): boolean {
  return (env.REALM_COUNSEL_SIGNOFF ?? '').trim() !== '';
}

// The flags that may not come up on mainnet without the full posture: the
// tradeable-token surface (curve listing) and power conversion.
const MAINNET_GATED_FLAGS = ['REALM_LAUNCHPAD_ENABLED', 'REALM_POWER_CREDIT_ENABLED'] as const;

export type MainnetComplianceIssue =
  | 'counsel_signoff_missing'
  | 'geo_gate_disabled'
  | 'ofac_screen_disabled';

export interface MainnetComplianceResult {
  // The preconditions missing while a gated flag was up on mainnet.
  issues: MainnetComplianceIssue[];
  // The flags this call forced back to '0'.
  disabled: string[];
}

// Boot-time enforcement (PRD: "flag-gated, default-off, until geo-screening +
// counsel sign-off"): on a mainnet RPC, any gated flag raised without the
// recorded sign-off + geo gate + OFAC screen is forced OFF in place, so the
// downstream env reads (realmLaunchpadHost, powerCreditEnabled) simply see the
// feature dark. Devnet/localnet is untouched: dry-runs need no sign-off.
export function enforceMainnetComplianceGate(
  env: Record<string, string | undefined>,
  rpcUrl: string,
): MainnetComplianceResult {
  if (!isMainnetRpc(rpcUrl)) return { issues: [], disabled: [] };
  const raised = MAINNET_GATED_FLAGS.filter((flag) => (env[flag] ?? '').trim() === '1');
  if (raised.length === 0) return { issues: [], disabled: [] };

  const issues: MainnetComplianceIssue[] = [];
  if (!counselSignoffRecorded(env)) issues.push('counsel_signoff_missing');
  if (!geoGateEnabled(env)) issues.push('geo_gate_disabled');
  if ((env.REALM_OFAC_SCREEN_ENABLED ?? '').trim() !== '1') issues.push('ofac_screen_disabled');
  if (issues.length === 0) return { issues: [], disabled: [] };

  for (const flag of raised) env[flag] = '0';
  return { issues, disabled: [...raised] };
}
