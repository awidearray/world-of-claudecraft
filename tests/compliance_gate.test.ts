// Launchpad phase 8 (server/compliance_gate.ts + server/sanctions.ts): the IP
// geo gate on money routes, the OFAC SDN wallet screen, the mainnet
// enablement gate (counsel sign-off + both screens or the tradeable/power
// flags are forced off at boot), and the pay-to-win labeling pin. Everything
// is DEFAULT OFF; these tests pin both the dark default and the fail-closed
// behavior once a gate is up.

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  blockedCountries,
  DEFAULT_BLOCKED_COUNTRIES,
  enforceMainnetComplianceGate,
  geoCheck,
  geoCountryHeader,
  geoGateEnabled,
  isMainnetRpc,
  resolveRequestCountry,
} from '../server/compliance_gate';
import {
  parseSdnDigitalCurrencyAddresses,
  SanctionedWalletError,
  SanctionsUnavailableError,
  SdnList,
  sdnListUrl,
  sdnScreenEnabled,
} from '../server/sanctions';

const ON = { REALM_GEO_GATE_ENABLED: '1' };

// ── Geo gate ─────────────────────────────────────────────────────────────────

describe('geo gate (middleware on every launchpad money route)', () => {
  it('is DEFAULT OFF: passes everything, even embargoed regions', () => {
    expect(geoGateEnabled({})).toBe(false);
    expect(geoCheck({ 'cf-ipcountry': 'IR' }, {})).toEqual({ ok: true });
    expect(geoCheck({}, {})).toEqual({ ok: true });
  });

  it('blocks every OFAC comprehensive-embargo jurisdiction with 451', () => {
    for (const country of DEFAULT_BLOCKED_COUNTRIES) {
      expect(geoCheck({ 'cf-ipcountry': country }, ON)).toEqual({
        ok: false,
        status: 451,
        error: 'region_blocked',
      });
    }
  });

  it('passes unblocked regions and normalizes header case', () => {
    expect(geoCheck({ 'cf-ipcountry': 'US' }, ON)).toEqual({ ok: true });
    expect(geoCheck({ 'cf-ipcountry': 'de' }, ON)).toEqual({ ok: true });
    expect(geoCheck({ 'cf-ipcountry': ' jp ' }, ON)).toEqual({ ok: true });
  });

  it('FAILS CLOSED on a missing, malformed, unknown, or Tor origin', () => {
    for (const headers of [
      {},
      { 'cf-ipcountry': 'USA' }, // malformed (3 chars)
      { 'cf-ipcountry': '' },
      { 'cf-ipcountry': 'XX' }, // Cloudflare: unknown
      { 'cf-ipcountry': 'T1' }, // Cloudflare: Tor exit
    ]) {
      const res = geoCheck(headers, ON);
      expect(res.ok, JSON.stringify(headers)).toBe(false);
      if (!res.ok) expect(res.status).toBe(451);
    }
  });

  it('env list EXTENDS the embargo floor and can never shrink it', () => {
    const env = { ...ON, REALM_GEO_BLOCKED_COUNTRIES: 'ru, by,junk,us1' };
    const set = blockedCountries(env);
    expect(set.has('RU')).toBe(true);
    expect(set.has('BY')).toBe(true);
    for (const country of DEFAULT_BLOCKED_COUNTRIES) expect(set.has(country)).toBe(true);
    expect(set.has('US')).toBe(false); // malformed entries ignored
    expect(geoCheck({ 'cf-ipcountry': 'RU' }, env)).toMatchObject({ ok: false, status: 451 });
    // There is no unblock syntax: the floor survives any env value.
    expect(blockedCountries({ REALM_GEO_BLOCKED_COUNTRIES: '' }).has('KP')).toBe(true);
  });

  it('reads the country from a configurable edge header', () => {
    expect(geoCountryHeader({})).toBe('cf-ipcountry');
    const env = { ...ON, REALM_GEO_COUNTRY_HEADER: 'X-Geo-Country' };
    expect(geoCountryHeader(env)).toBe('x-geo-country'); // node lowercases
    expect(resolveRequestCountry({ 'x-geo-country': 'FR' }, env)).toBe('FR');
    expect(geoCheck({ 'x-geo-country': 'SY' }, env)).toMatchObject({ ok: false, status: 451 });
    // A multi-valued header resolves to its first value.
    expect(resolveRequestCountry({ 'cf-ipcountry': ['CA', 'IR'] }, ON)).toBe('CA');
  });
});

// ── OFAC SDN wallet screen ───────────────────────────────────────────────────

// Remarks text as it appears in the OFAC flat file: multiple asset tags,
// semicolon-terminated, one line per entry.
const SDN_SAMPLE = [
  '"12345","EVIL CORP","-0-","Digital Currency Address - XBT 12QtD5BFwRsdNsAZY76UVE1xyCGNTojH9h; Digital Currency Address - ETH 0x123 invalid;"',
  '"12346","BAD ACTOR","-0-","Digital Currency Address - SOL 9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin; Secondary sanctions risk:"',
  '"12347","DUPLICATE","-0-","Digital Currency Address - SOL 9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin;"',
].join('\n');

describe('OFAC SDN wallet screen', () => {
  it('is DEFAULT OFF and points at the treasury.gov flat file by default', () => {
    expect(sdnScreenEnabled({})).toBe(false);
    expect(sdnListUrl({})).toBe('https://www.treasury.gov/ofac/downloads/sdn.csv');
    expect(sdnListUrl({ REALM_OFAC_SDN_URL: 'https://mirror.example/sdn.csv' })).toBe(
      'https://mirror.example/sdn.csv',
    );
  });

  it('parses digital currency addresses across asset tags and dedupes', () => {
    const addresses = parseSdnDigitalCurrencyAddresses(SDN_SAMPLE);
    expect(addresses.has('12QtD5BFwRsdNsAZY76UVE1xyCGNTojH9h')).toBe(true);
    expect(addresses.has('9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin')).toBe(true);
    // The malformed 0x123 fragment (too short, 0 not base58) never enters.
    expect(addresses.size).toBe(2);
  });

  it('FAILS CLOSED before the first load, then screens exactly', async () => {
    const list = new SdnList(async () => SDN_SAMPLE);
    expect(list.loaded()).toBe(false);
    expect(() => list.assertClear('AnyWallet11111111111111111111111111111111111')).toThrow(
      SanctionsUnavailableError,
    );
    expect(await list.load()).toBe(2);
    expect(list.loaded()).toBe(true);
    expect(() => list.assertClear('9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin')).toThrow(
      SanctionedWalletError,
    );
    expect(() => list.assertClear('CleanWallet1111111111111111111111111111111111')).not.toThrow();
  });

  it('a failed refresh keeps the previous list screening', async () => {
    let fail = false;
    const list = new SdnList(async () => {
      if (fail) throw new Error('fetch down');
      return SDN_SAMPLE;
    });
    await list.load();
    fail = true;
    await expect(list.load()).rejects.toThrow('fetch down');
    // The last good list still screens (start() swallows refresh failures).
    expect(() => list.assertClear('9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin')).toThrow(
      SanctionedWalletError,
    );
  });
});

// ── Mainnet enablement gate ──────────────────────────────────────────────────

const MAINNET = 'https://api.mainnet-beta.solana.com';
const DEVNET = 'https://api.devnet.solana.com';
const FULL_POSTURE = {
  REALM_COUNSEL_SIGNOFF: 'memo-2026-07-01',
  REALM_GEO_GATE_ENABLED: '1',
  REALM_OFAC_SCREEN_ENABLED: '1',
};

describe('mainnet enablement gate (counsel sign-off + both screens)', () => {
  it('recognizes mainnet RPC urls', () => {
    expect(isMainnetRpc(MAINNET)).toBe(true);
    expect(isMainnetRpc('https://mainnet.helius-rpc.com/?api-key=x')).toBe(true);
    expect(isMainnetRpc(DEVNET)).toBe(false);
    expect(isMainnetRpc('http://127.0.0.1:8899')).toBe(false);
  });

  it('devnet is untouched: dry-runs need no sign-off', () => {
    const env = { REALM_LAUNCHPAD_ENABLED: '1', REALM_POWER_CREDIT_ENABLED: '1' };
    expect(enforceMainnetComplianceGate(env, DEVNET)).toEqual({ issues: [], disabled: [] });
    expect(env.REALM_LAUNCHPAD_ENABLED).toBe('1');
  });

  it('forces every raised gated flag off on mainnet without the posture', () => {
    const env: Record<string, string | undefined> = {
      REALM_LAUNCHPAD_ENABLED: '1',
      REALM_POWER_CREDIT_ENABLED: '1',
    };
    const result = enforceMainnetComplianceGate(env, MAINNET);
    expect(result.issues).toEqual([
      'counsel_signoff_missing',
      'geo_gate_disabled',
      'ofac_screen_disabled',
    ]);
    expect(result.disabled).toEqual(['REALM_LAUNCHPAD_ENABLED', 'REALM_POWER_CREDIT_ENABLED']);
    expect(env.REALM_LAUNCHPAD_ENABLED).toBe('0');
    expect(env.REALM_POWER_CREDIT_ENABLED).toBe('0');
  });

  it('every precondition is individually load-bearing', () => {
    for (const missing of Object.keys(FULL_POSTURE)) {
      const env: Record<string, string | undefined> = {
        ...FULL_POSTURE,
        REALM_LAUNCHPAD_ENABLED: '1',
      };
      delete env[missing];
      const result = enforceMainnetComplianceGate(env, MAINNET);
      expect(result.disabled, `missing ${missing}`).toEqual(['REALM_LAUNCHPAD_ENABLED']);
      expect(env.REALM_LAUNCHPAD_ENABLED).toBe('0');
    }
  });

  it('the full posture keeps mainnet flags up; dark flags are left alone', () => {
    const up: Record<string, string | undefined> = {
      ...FULL_POSTURE,
      REALM_LAUNCHPAD_ENABLED: '1',
      REALM_POWER_CREDIT_ENABLED: '1',
    };
    expect(enforceMainnetComplianceGate(up, MAINNET)).toEqual({ issues: [], disabled: [] });
    expect(up.REALM_LAUNCHPAD_ENABLED).toBe('1');
    // Nothing raised: nothing to disable, no issues reported.
    const dark: Record<string, string | undefined> = {};
    expect(enforceMainnetComplianceGate(dark, MAINNET)).toEqual({ issues: [], disabled: [] });
    expect(dark.REALM_LAUNCHPAD_ENABLED).toBeUndefined();
  });
});

// ── Pay-to-win labeling (PRD D2) ─────────────────────────────────────────────

describe('pay-to-win labeling', () => {
  const panel = readFileSync('src/ui/realm_launchpad.ts', 'utf8');

  it('a power realm page always renders the pay-to-win banner', () => {
    // The banner render is gated on the policy, not on any flow state, so it
    // shows on every visit to a power realm's launchpad page.
    expect(panel).toMatch(
      /monetizationPolicy === 'power'[\s\S]{0,220}launchpad\.policy\.powerBanner/,
    );
  });

  it('registration defaults to cosmetic; power is an explicit opt-in', () => {
    // The select's first option (and the fallback when unset) is cosmetic.
    const cosmetic = panel.indexOf('option value="cosmetic"');
    const power = panel.indexOf('option value="power"');
    expect(cosmetic).toBeGreaterThan(-1);
    expect(power).toBeGreaterThan(cosmetic);
    expect(panel).toContain("'cosmetic') as 'cosmetic' | 'power'");
  });

  it('the facilitator disclosure renders on every launchpad page', () => {
    expect(panel).toContain('launchpad.termsNote');
  });
});
