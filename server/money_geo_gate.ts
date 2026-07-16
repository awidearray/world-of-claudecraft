// Money-route geo + OFAC gate (launchpad phase 8, PRD section 10). The
// regulatory hardening the tradeable-token and power-realm surfaces sit behind:
//
//   - OFAC SDN screening: a payer wallet on the sanctioned-address list is
//     blocked. The list is loaded from OFAC_SDN_WALLETS (comma-separated) or
//     OFAC_SDN_WALLETS_FILE (one address per line); addresses are matched
//     case-sensitively (base58 is case-significant).
//   - IP geolocation: a request from a sanctioned or in-scope-restricted
//     country is blocked. The country is read from the edge (Cloudflare's
//     CF-IPCountry header, the standard for this deploy) and matched against
//     MONEY_BLOCKED_COUNTRIES (comma-separated ISO-3166 alpha-2). An UNKNOWN
//     country (no header) is blocked when the gate is enforcing, because a
//     money route must fail closed rather than trust an unscreened origin.
//
// The whole gate is FLAG-GATED: unset (MONEY_GEO_GATE_ENABLED != 1) it is a
// no-op, so development and the asset-only early phases run ungated. Mainnet
// enablement of the risky surfaces REQUIRES it on (see mainnetMoneyEnabled).
// Pure verdict logic here (unit-tested with injected inputs); the thin HTTP
// applier reads the request headers.

import { readFileSync } from 'node:fs';
import type * as http from 'node:http';
import { requestIp } from './ratelimit';

export function moneyGeoGateEnabled(): boolean {
  return (process.env.MONEY_GEO_GATE_ENABLED ?? '').trim() === '1';
}

// The sanctioned-country blocklist (ISO-3166 alpha-2, upper-cased). Defaults to
// the comprehensively sanctioned set so an operator who enables the gate
// without a list still blocks the obvious jurisdictions.
const DEFAULT_BLOCKED_COUNTRIES = ['CU', 'IR', 'KP', 'SY', 'RU', 'BY'];

export function blockedCountries(): Set<string> {
  const raw = (process.env.MONEY_BLOCKED_COUNTRIES ?? '').trim();
  const list = raw
    ? raw
        .split(',')
        .map((c) => c.trim().toUpperCase())
        .filter(Boolean)
    : DEFAULT_BLOCKED_COUNTRIES;
  return new Set(list);
}

let cachedSdn: Set<string> | null = null;

// The OFAC SDN wallet list. Read once and cached (it is ops-managed static
// data). From OFAC_SDN_WALLETS (comma-separated) and/or OFAC_SDN_WALLETS_FILE
// (one per line, '#' comments allowed).
export function sdnWallets(): Set<string> {
  if (cachedSdn) return cachedSdn;
  const set = new Set<string>();
  const inline = (process.env.OFAC_SDN_WALLETS ?? '').trim();
  for (const w of inline.split(',').map((s) => s.trim())) if (w) set.add(w);
  const file = (process.env.OFAC_SDN_WALLETS_FILE ?? '').trim();
  if (file) {
    for (const line of readFileSync(file, 'utf8').split('\n')) {
      const w = line.split('#')[0].trim();
      if (w) set.add(w);
    }
  }
  cachedSdn = set;
  return set;
}

/** Reset the SDN cache (tests set the env then re-read). */
export function resetSdnCacheForTests(): void {
  cachedSdn = null;
}

// ── Pure verdict ──────────────────────────────────────────────────────────────

export type GeoVerdict =
  | { ok: true }
  | { ok: false; reason: 'geo_blocked' | 'sanctioned_wallet' | 'geo_gate_required' };

// The pure gate decision for a MONEY route. The posture is by cluster:
//   - not mainnet: everything passes (devnet/localnet money is not real).
//   - mainnet + (gate NOT enforcing OR counsel NOT recorded): BLOCK with
//     geo_gate_required. A real-money route can never run on mainnet without
//     BOTH the geo/OFAC gate active AND the counsel sign-off recorded; a
//     misconfigured or un-signed-off deploy fails closed.
//   - mainnet + gate enforcing + counsel recorded: screen the country (fail
//     closed on unknown) and the payer wallet against the SDN list.
export function geoGateVerdict(args: {
  isMainnet: boolean;
  enforcing: boolean;
  counselRecorded: boolean;
  country: string | null;
  wallet: string | null;
  blocked: Set<string>;
  sdn: Set<string>;
}): GeoVerdict {
  if (!args.isMainnet) return { ok: true };
  if (!args.enforcing || !args.counselRecorded) return { ok: false, reason: 'geo_gate_required' };
  // Fail closed on an unknown origin: a money route cannot serve an unscreened IP.
  if (args.country === null) return { ok: false, reason: 'geo_blocked' };
  if (args.blocked.has(args.country.toUpperCase())) return { ok: false, reason: 'geo_blocked' };
  if (args.wallet !== null && args.sdn.has(args.wallet)) {
    return { ok: false, reason: 'sanctioned_wallet' };
  }
  return { ok: true };
}

// The edge-resolved country for a request: Cloudflare's CF-IPCountry header
// (the deploy's standard), upper-cased; null when absent or the placeholder
// 'XX' Cloudflare sends for an unresolvable IP.
export function requestCountry(req: http.IncomingMessage): string | null {
  const raw = String(req.headers['cf-ipcountry'] ?? '')
    .trim()
    .toUpperCase();
  if (!raw || raw === 'XX' || raw === 'T1') return null; // T1 = Tor exit
  return raw;
}

// The HTTP applier: screen a money request against the cluster in `rpcUrl`.
// Returns the typed verdict the route serves as 403 when blocked. `wallet` is
// the payer's linked wallet when the route knows it (else null).
export function screenMoneyRequest(
  req: http.IncomingMessage,
  wallet: string | null,
  rpcUrl: string,
): GeoVerdict {
  // requestIp is resolved for parity with the rate limiter's XFF handling even
  // though the country comes from the edge header; referencing it keeps the two
  // IP-resolution paths import-coupled so a future direct-geo lookup has one seam.
  void requestIp;
  return geoGateVerdict({
    isMainnet: /mainnet/.test(rpcUrl),
    enforcing: moneyGeoGateEnabled(),
    counselRecorded: counselSignoffRecorded(),
    country: requestCountry(req),
    wallet,
    blocked: blockedCountries(),
    sdn: sdnWallets(),
  });
}

// ── The mainnet-enablement gate (counsel + flags) ─────────────────────────────

// Mainnet enablement of the risky money surfaces (tradeable tokens, power
// realms, the Levy Fund page) requires ALL of: the geo gate enforcing, a
// recorded counsel sign-off, and the specific feature flag on. This is the
// single check every mainnet-gated path calls; it can never be true by default.
export function counselSignoffRecorded(): boolean {
  // A non-empty, ops-set marker (e.g. a memo id + date) recorded only after the
  // written counsel sign-off exists. Its mere presence is the gate; the value
  // is logged for the audit trail.
  return (process.env.LAUNCHPAD_COUNSEL_SIGNOFF ?? '').trim().length > 0;
}

// Whether a specific risky money feature may run on mainnet. `featureFlag` is
// the feature's own default-off flag value (e.g. powerCreditEnabled()). On a
// non-mainnet cluster the geo/counsel gates do not apply (devnet has no real
// money); on mainnet, ALL gates must pass.
export function mainnetMoneyEnabled(featureFlag: boolean, rpcUrl: string): boolean {
  if (!featureFlag) return false;
  const isMainnet = /mainnet/.test(rpcUrl);
  if (!isMainnet) return true; // devnet/localnet: the money is not real
  return moneyGeoGateEnabled() && counselSignoffRecorded();
}
