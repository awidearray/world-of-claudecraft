// Launchpad phase 8 regulatory hardening (server/money_geo_gate.ts): the pure
// geo + OFAC verdict by cluster, the mainnet counsel + gate requirement, the
// SDN list loading, the edge country resolution, and (with the phase-3 rug
// summary) the RugCheck/Birdeye clean-score acceptance invariants.

import type * as http from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import {
  blockedCountries,
  counselSignoffRecorded,
  geoGateVerdict,
  mainnetMoneyEnabled,
  moneyGeoGateEnabled,
  requestCountry,
  resetSdnCacheForTests,
  screenMoneyRequest,
  sdnWallets,
} from '../server/money_geo_gate';
import { mintRugSummary, type ParsedMintInfo } from '../server/solana_token2022';

const ENV = [
  'MONEY_GEO_GATE_ENABLED',
  'MONEY_BLOCKED_COUNTRIES',
  'OFAC_SDN_WALLETS',
  'LAUNCHPAD_COUNSEL_SIGNOFF',
];
afterEach(() => {
  for (const k of ENV) delete process.env[k];
  resetSdnCacheForTests();
});

const MAINNET = 'https://api.mainnet-beta.solana.com';
const DEVNET = 'https://api.devnet.solana.com';
const SDN_WALLET = 'Sanctioned1111111111111111111111111111111111';
const CLEAN_WALLET = 'Clean1111111111111111111111111111111111111';

describe('geoGateVerdict (pure, by cluster)', () => {
  const base = {
    blocked: new Set(['KP', 'IR']),
    sdn: new Set([SDN_WALLET]),
    country: 'US' as string | null,
    wallet: CLEAN_WALLET as string | null,
  };

  it('passes everything on a non-mainnet cluster (money is not real)', () => {
    expect(
      geoGateVerdict({ ...base, isMainnet: false, enforcing: false, counselRecorded: false }),
    ).toEqual({ ok: true });
  });

  it('on mainnet, requires BOTH the gate enforcing and counsel recorded', () => {
    expect(
      geoGateVerdict({ ...base, isMainnet: true, enforcing: false, counselRecorded: true }),
    ).toEqual({ ok: false, reason: 'geo_gate_required' });
    expect(
      geoGateVerdict({ ...base, isMainnet: true, enforcing: true, counselRecorded: false }),
    ).toEqual({ ok: false, reason: 'geo_gate_required' });
    expect(
      geoGateVerdict({ ...base, isMainnet: true, enforcing: true, counselRecorded: true }),
    ).toEqual({ ok: true });
  });

  it('on mainnet, blocks a sanctioned country and fails closed on an unknown one', () => {
    const on = { ...base, isMainnet: true, enforcing: true, counselRecorded: true };
    expect(geoGateVerdict({ ...on, country: 'KP' })).toEqual({ ok: false, reason: 'geo_blocked' });
    expect(geoGateVerdict({ ...on, country: null })).toEqual({ ok: false, reason: 'geo_blocked' });
    expect(geoGateVerdict({ ...on, country: 'ir' })).toEqual({ ok: false, reason: 'geo_blocked' }); // case-insensitive
  });

  it('on mainnet, blocks a sanctioned payer wallet', () => {
    const on = { ...base, isMainnet: true, enforcing: true, counselRecorded: true };
    expect(geoGateVerdict({ ...on, wallet: SDN_WALLET })).toEqual({
      ok: false,
      reason: 'sanctioned_wallet',
    });
    // A null wallet (a route with no payer) is not screened for SDN.
    expect(geoGateVerdict({ ...on, wallet: null })).toEqual({ ok: true });
  });
});

describe('config loaders', () => {
  it('the gate flag defaults off', () => {
    expect(moneyGeoGateEnabled()).toBe(false);
    process.env.MONEY_GEO_GATE_ENABLED = '1';
    expect(moneyGeoGateEnabled()).toBe(true);
  });

  it('blockedCountries defaults to the sanctioned set and honors an override', () => {
    expect(blockedCountries().has('KP')).toBe(true);
    expect(blockedCountries().has('IR')).toBe(true);
    process.env.MONEY_BLOCKED_COUNTRIES = 'aa, bb';
    expect(blockedCountries()).toEqual(new Set(['AA', 'BB']));
  });

  it('sdnWallets loads the inline list (cached)', () => {
    process.env.OFAC_SDN_WALLETS = `${SDN_WALLET}, Other222`;
    expect(sdnWallets().has(SDN_WALLET)).toBe(true);
    expect(sdnWallets().has('Other222')).toBe(true);
  });

  it('counselSignoffRecorded requires a non-empty marker', () => {
    expect(counselSignoffRecorded()).toBe(false);
    process.env.LAUNCHPAD_COUNSEL_SIGNOFF = 'memo-2026-07-11';
    expect(counselSignoffRecorded()).toBe(true);
  });
});

describe('requestCountry (edge header)', () => {
  const req = (country?: string): http.IncomingMessage =>
    ({ headers: country === undefined ? {} : { 'cf-ipcountry': country } }) as http.IncomingMessage;
  it('reads and upper-cases CF-IPCountry, nulling XX / T1 / absent', () => {
    expect(requestCountry(req('us'))).toBe('US');
    expect(requestCountry(req('XX'))).toBeNull();
    expect(requestCountry(req('T1'))).toBeNull(); // Tor
    expect(requestCountry(req())).toBeNull();
  });
});

describe('screenMoneyRequest (the applier)', () => {
  const req = (country?: string): http.IncomingMessage =>
    ({ headers: country === undefined ? {} : { 'cf-ipcountry': country } }) as http.IncomingMessage;

  it('devnet: always allowed', () => {
    expect(screenMoneyRequest(req(), CLEAN_WALLET, DEVNET)).toEqual({ ok: true });
  });

  it('mainnet unconfigured: blocked (fail closed)', () => {
    expect(screenMoneyRequest(req('US'), CLEAN_WALLET, MAINNET)).toEqual({
      ok: false,
      reason: 'geo_gate_required',
    });
  });

  it('mainnet fully configured + clean: allowed', () => {
    process.env.MONEY_GEO_GATE_ENABLED = '1';
    process.env.LAUNCHPAD_COUNSEL_SIGNOFF = 'memo';
    process.env.OFAC_SDN_WALLETS = SDN_WALLET;
    expect(screenMoneyRequest(req('US'), CLEAN_WALLET, MAINNET)).toEqual({ ok: true });
    expect(screenMoneyRequest(req('IR'), CLEAN_WALLET, MAINNET)).toMatchObject({
      ok: false,
      reason: 'geo_blocked',
    });
    expect(screenMoneyRequest(req('US'), SDN_WALLET, MAINNET)).toMatchObject({
      ok: false,
      reason: 'sanctioned_wallet',
    });
  });
});

describe('mainnetMoneyEnabled (the feature gate)', () => {
  it('devnet: the feature flag alone enables', () => {
    expect(mainnetMoneyEnabled(true, DEVNET)).toBe(true);
    expect(mainnetMoneyEnabled(false, DEVNET)).toBe(false);
  });

  it('mainnet: requires the flag AND the gate AND counsel', () => {
    expect(mainnetMoneyEnabled(true, MAINNET)).toBe(false); // nothing set
    process.env.MONEY_GEO_GATE_ENABLED = '1';
    expect(mainnetMoneyEnabled(true, MAINNET)).toBe(false); // no counsel
    process.env.LAUNCHPAD_COUNSEL_SIGNOFF = 'memo';
    expect(mainnetMoneyEnabled(true, MAINNET)).toBe(true);
    expect(mainnetMoneyEnabled(false, MAINNET)).toBe(false); // flag still gates
  });
});

// ── RugCheck / Birdeye clean-score acceptance (with the phase-3 summary) ──────

describe('clean-score acceptance', () => {
  const mint = 'Mint1111111111111111111111111111111111111111';
  const cleanMint: ParsedMintInfo = {
    program: 'spl-token-2022',
    decimals: 9,
    supplyBase: 1_000_000_000n,
    mintAuthority: null, // renounced
    freezeAuthority: null, // never set
    extensions: [{ extension: 'metadataPointer' }, { extension: 'tokenMetadata' }],
    metadata: { name: 'MOON', symbol: 'MOON', uri: '', updateAuthority: null }, // immutable
    metadataPointer: { authority: null, metadataAddress: mint },
  };

  it('a boring metadata-only mint scores clean by construction', () => {
    const s = mintRugSummary(mint, cleanMint);
    expect(s.clean).toBe(true);
    expect(s).toMatchObject({
      isToken2022: true,
      mintAuthorityNull: true,
      freezeAuthorityNull: true,
      metadataImmutable: true,
      metadataPointerSelf: true,
      forbiddenExtensions: [],
    });
  });

  it('every rug vector reddens the score', () => {
    expect(mintRugSummary(mint, { ...cleanMint, mintAuthority: 'X' }).clean).toBe(false);
    expect(mintRugSummary(mint, { ...cleanMint, freezeAuthority: 'X' }).clean).toBe(false);
    expect(
      mintRugSummary(mint, {
        ...cleanMint,
        extensions: [...cleanMint.extensions, { extension: 'permanentDelegate' }],
      }).clean,
    ).toBe(false);
    expect(
      mintRugSummary(mint, {
        ...cleanMint,
        metadata: { name: 'M', symbol: 'M', uri: '', updateAuthority: 'X' },
      }).clean,
    ).toBe(false);
  });
});
