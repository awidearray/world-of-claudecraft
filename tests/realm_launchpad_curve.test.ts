// Launchpad phase 4 (server/realm_launchpad.ts): the Launchpad seam and its
// orchestration against in-memory fakes. Covers the exact migration-progress
// math, the structural config guarantees (DAMM v2 + fully locked LP + locked
// vesting + a real threshold, all read from the LIVE config), the flag-gated
// host factory (default OFF), the fixed-rate stub host (devnet-only, lists the
// phase 3 pre-minted token through the verified-locks gate, never graduates),
// the Meteora adapter (DBC-minted tokens only, foreign-config pools rejected),
// and the listing + graduation transitions with their guarded CAS writes.

import { Keypair } from '@solana/web3.js';
import { afterEach, describe, expect, it } from 'vitest';
import {
  type CurveDeps,
  type CurveState,
  configGuaranteeIssues,
  confirmCurve,
  confirmGraduation,
  curveInfo,
  type DbcGateway,
  FixedRateStubLaunchpad,
  type GraduationState,
  type Launchpad,
  type LaunchpadPartnerConfig,
  MeteoraDbcLaunchpad,
  migrationProgressBps,
  minLockedLpBps,
  prepareCurve,
  realmFeeClaimerPda,
  realmLaunchpadHost,
  stubCurveAddress,
} from '../server/realm_launchpad';
import type {
  MonetizationPolicy,
  RealmToken,
  RealmTokenDb,
  RealmTokenStatus,
} from '../server/realm_token';
import type { RealmTokenLaunch, RealmTokenLaunchStore } from '../server/realm_token_mint';

const FOUNDER = Keypair.generate().publicKey.toBase58();
const CONFIG = Keypair.generate().publicKey.toBase58();
const OTHER_CONFIG = Keypair.generate().publicKey.toBase58();
const DBC_MINT = Keypair.generate().publicKey.toBase58();
const POOL = Keypair.generate().publicKey.toBase58();
const DAMM_POOL = Keypair.generate().publicKey.toBase58();
const PREMINT = Keypair.generate().publicKey.toBase58();

const REALM = 7;
const ACCOUNT = 1;

// ── Fakes ────────────────────────────────────────────────────────────────────

function tokenRow(realmId: number, over: Partial<RealmToken> = {}): RealmToken {
  return {
    realmId,
    mint: null,
    decimals: 9,
    symbol: 'MOON',
    icon: '',
    status: 'funded',
    monetizationPolicy: 'cosmetic' as MonetizationPolicy,
    curveAddress: null,
    poolAddress: null,
    lpLockAddress: null,
    feeClaimerPda: null,
    launchTxSig: null,
    createdAt: new Date('2026-07-01T00:00:00Z'),
    updatedAt: new Date('2026-07-01T00:00:00Z'),
    ...over,
  };
}

class FakeTokenDb implements RealmTokenDb {
  rows = new Map<number, RealmToken>();
  async getRealmToken(realmId: number): Promise<RealmToken | null> {
    return this.rows.get(realmId) ?? null;
  }
  async insertRealmToken(): Promise<RealmToken> {
    throw new Error('unused');
  }
  async listRealmTokens(): Promise<Map<number, RealmToken>> {
    return new Map();
  }
  async setRealmTokenStatus(
    realmId: number,
    from: readonly RealmTokenStatus[],
    to: RealmTokenStatus,
  ): Promise<RealmToken | null> {
    const row = this.rows.get(realmId);
    if (!row || !from.includes(row.status)) return null;
    const next = { ...row, status: to };
    this.rows.set(realmId, next);
    return next;
  }
}

function launchRow(realmId: number, over: Partial<RealmTokenLaunch> = {}): RealmTokenLaunch {
  return {
    realmId,
    pendingMint: PREMINT,
    supplyBase: 10n ** 18n,
    alloc: {
      publicBps: 6000,
      liquidityBps: 1000,
      founderBps: 1200,
      levyBps: 800,
      treasuryBps: 1000,
    },
    founderWallet: FOUNDER,
    levyWallet: FOUNDER,
    treasuryWallet: FOUNDER,
    founderLockAddress: 'FL',
    levyLockAddress: 'LL',
    treasuryLockAddress: 'TL',
    mintConfirmedAt: new Date(),
    locksVerifiedAt: new Date(),
    createdAt: new Date(),
    updatedAt: new Date(),
    ...over,
  };
}

class FakeLaunchStore implements RealmTokenLaunchStore {
  rows = new Map<number, RealmTokenLaunch>();
  async getLaunch(realmId: number): Promise<RealmTokenLaunch | null> {
    return this.rows.get(realmId) ?? null;
  }
  async upsertPendingLaunch(): Promise<boolean> {
    return true;
  }
  async recordMintCreated(): Promise<boolean> {
    return true;
  }
  async setLockAddresses(): Promise<boolean> {
    return true;
  }
  async markLocksVerified(): Promise<boolean> {
    return true;
  }
}

function goodConfig(over: Partial<LaunchpadPartnerConfig> = {}): LaunchpadPartnerConfig {
  return {
    configAddress: CONFIG,
    quoteMint: '',
    feeClaimer: FOUNDER,
    migrationQuoteThresholdBase: 100_000_000_000n,
    migrationOption: 1,
    tokenType: 1,
    partnerLockedLpBps: 6000,
    creatorLockedLpBps: 4000,
    lockedVestingPresent: true,
    ...over,
  };
}

class FakeGateway implements DbcGateway {
  config: LaunchpadPartnerConfig | null = goodConfig();
  pools = new Map<string, CurveState>();
  graduation: GraduationState | null = null;
  built: { txBase64: string; baseMint: string } | null = {
    txBase64: 'dHg=',
    baseMint: DBC_MINT,
  };
  async getPoolConfig(configAddress: string): Promise<LaunchpadPartnerConfig | null> {
    return this.config && this.config.configAddress === configAddress ? this.config : null;
  }
  async getPoolByBaseMint(baseMint: string): Promise<CurveState | null> {
    return this.pools.get(baseMint) ?? null;
  }
  async buildCreatePoolTx(): Promise<{ txBase64: string; baseMint: string } | null> {
    return this.built;
  }
  async getDammV2PoolLock(): Promise<GraduationState | null> {
    return this.graduation;
  }
}

interface Harness {
  deps: CurveDeps;
  tokens: FakeTokenDb;
  launches: FakeLaunchStore;
  gateway: FakeGateway;
}

function harness(
  host: Launchpad | null,
  over: { owner?: boolean; wallet?: string | null } = {},
): Harness {
  const tokens = new FakeTokenDb();
  const launches = new FakeLaunchStore();
  const gateway = new FakeGateway();
  const deps: CurveDeps = {
    tokens,
    launches,
    host,
    walletForAccount: async () =>
      over.wallet === null ? null : { pubkey: over.wallet ?? FOUNDER },
    rolesForAccountOnRealm: async () => (over.owner === false ? [] : ['owner']),
    recordCurveListed: async (realmId, fields) => {
      const row = tokens.rows.get(realmId);
      if (!row || row.curveAddress !== null || row.status !== 'funded') return false;
      if (row.mint !== null && row.mint !== fields.mint) return false;
      tokens.rows.set(realmId, {
        ...row,
        mint: fields.mint,
        curveAddress: fields.curveAddress,
        feeClaimerPda: fields.feeClaimerPda,
      });
      return true;
    },
    recordGraduation: async (realmId, fields) => {
      const row = tokens.rows.get(realmId);
      if (!row || row.status !== 'live') return null;
      const next = {
        ...row,
        poolAddress: fields.poolAddress,
        lpLockAddress: fields.lpLockAddress,
        status: 'graduated' as const,
      };
      tokens.rows.set(realmId, next);
      return next;
    },
  };
  return { deps, tokens, launches, gateway };
}

const DEVNET_RPC = 'https://api.devnet.solana.com';
const MAINNET_RPC = 'https://api.mainnet-beta.solana.com';

afterEach(() => {
  delete process.env.REALM_LP_LOCK_MIN_BPS;
});

// ── Pure math + verdicts ─────────────────────────────────────────────────────

describe('migrationProgressBps', () => {
  it('is exact at the boundaries and capped for display', () => {
    expect(migrationProgressBps(0n, 100n)).toBe(0);
    expect(migrationProgressBps(50n, 100n)).toBe(5000);
    expect(migrationProgressBps(100n, 100n)).toBe(10_000);
    expect(migrationProgressBps(250n, 100n)).toBe(10_000);
    expect(migrationProgressBps(99n, 100n)).toBe(9900);
    expect(migrationProgressBps(10n, 0n)).toBe(0); // unreadable threshold
  });
});

describe('configGuaranteeIssues', () => {
  it('passes the fully locked DAMM v2 profile', () => {
    expect(configGuaranteeIssues(goodConfig(), 10_000)).toEqual([]);
  });

  it('flags every broken structural guarantee', () => {
    expect(configGuaranteeIssues(goodConfig({ migrationOption: 0 }), 10_000)).toContain(
      'not_damm_v2',
    );
    expect(
      configGuaranteeIssues(
        goodConfig({ partnerLockedLpBps: 5000, creatorLockedLpBps: 4999 }),
        10_000,
      ),
    ).toContain('lp_not_permanently_locked');
    expect(configGuaranteeIssues(goodConfig({ lockedVestingPresent: false }), 10_000)).toContain(
      'no_locked_vesting',
    );
    expect(
      configGuaranteeIssues(goodConfig({ migrationQuoteThresholdBase: 0n }), 10_000),
    ).toContain('no_migration_threshold');
  });

  it('minLockedLpBps defaults to the full LP and rejects garbage', () => {
    expect(minLockedLpBps({})).toBe(10_000);
    expect(minLockedLpBps({ REALM_LP_LOCK_MIN_BPS: '8000' })).toBe(8000);
    expect(minLockedLpBps({ REALM_LP_LOCK_MIN_BPS: '0' })).toBe(10_000);
    expect(minLockedLpBps({ REALM_LP_LOCK_MIN_BPS: 'half' })).toBe(10_000);
  });
});

describe('realmFeeClaimerPda', () => {
  it('derives a stable, per-realm program address (never an EOA)', () => {
    const a = realmFeeClaimerPda(7);
    expect(a).toBe(realmFeeClaimerPda(7));
    expect(a).not.toBe(realmFeeClaimerPda(8));
    expect(a.length).toBeGreaterThanOrEqual(32);
  });
});

// ── Host factory gating ──────────────────────────────────────────────────────

describe('realmLaunchpadHost', () => {
  it('is OFF by default and off unless explicitly enabled', () => {
    expect(realmLaunchpadHost({ env: {} })).toBeNull();
    expect(realmLaunchpadHost({ env: { REALM_LAUNCHPAD_ENABLED: '0' } })).toBeNull();
  });

  it('selects the stub host', () => {
    const host = realmLaunchpadHost({
      env: { REALM_LAUNCHPAD_ENABLED: '1', REALM_LAUNCHPAD_HOST: 'stub' },
    });
    expect(host?.kind).toBe('fixed-rate-stub');
  });

  it('meteora needs a valid config address and a live gateway', () => {
    expect(realmLaunchpadHost({ env: { REALM_LAUNCHPAD_ENABLED: '1' } })).toBeNull();
    expect(
      realmLaunchpadHost({
        env: { REALM_LAUNCHPAD_ENABLED: '1', REALM_DBC_CONFIG: 'not-an-address' },
        liveGateway: () => new FakeGateway(),
      }),
    ).toBeNull();
    const host = realmLaunchpadHost({
      env: { REALM_LAUNCHPAD_ENABLED: '1', REALM_DBC_CONFIG: CONFIG },
      liveGateway: () => new FakeGateway(),
    });
    expect(host?.kind).toBe('meteora-dbc');
  });
});

// ── Stub host ────────────────────────────────────────────────────────────────

describe('FixedRateStubLaunchpad', () => {
  it('refuses to exist against mainnet', async () => {
    const stub = new FixedRateStubLaunchpad({}, MAINNET_RPC);
    expect(await stub.readPartnerConfig()).toBeNull();
    expect(await stub.prepareCurvePool({ realmId: REALM, premintedMint: PREMINT })).toBeNull();
    expect(
      await stub.readCurveState({ baseMint: PREMINT, curveAddress: stubCurveAddress(REALM) }),
    ).toBeNull();
  });

  it('serves a fixed-rate config off-mainnet and requires the pre-minted token', async () => {
    const stub = new FixedRateStubLaunchpad(
      { REALM_STUB_MIGRATION_THRESHOLD_BASE: '5000' },
      DEVNET_RPC,
    );
    const config = await stub.readPartnerConfig();
    expect(config?.migrationQuoteThresholdBase).toBe(5000n);
    expect(configGuaranteeIssues(config!, 10_000)).toEqual([]);
    expect(await stub.prepareCurvePool({ realmId: REALM, premintedMint: null })).toBeNull();
    expect(await stub.prepareCurvePool({ realmId: REALM, premintedMint: PREMINT })).toEqual({
      txBase64: null,
      baseMint: PREMINT,
    });
    expect(await stub.readGraduation()).toBeNull(); // a stub never graduates
  });
});

// ── Meteora adapter ──────────────────────────────────────────────────────────

describe('MeteoraDbcLaunchpad', () => {
  it('rejects a pre-minted token (the DBC creates its own)', async () => {
    const gateway = new FakeGateway();
    const host = new MeteoraDbcLaunchpad(gateway, CONFIG);
    expect(
      await host.prepareCurvePool({
        realmId: REALM,
        founderWallet: FOUNDER,
        name: 'Moon',
        symbol: 'MOON',
        uri: '',
        premintedMint: PREMINT,
      }),
    ).toBeNull();
  });

  it('only recognizes pools under OUR partner config', async () => {
    const gateway = new FakeGateway();
    const host = new MeteoraDbcLaunchpad(gateway, CONFIG);
    gateway.pools.set(DBC_MINT, {
      poolAddress: POOL,
      configAddress: OTHER_CONFIG,
      baseMint: DBC_MINT,
      creator: FOUNDER,
      quoteReserveBase: 0n,
      sqrtPrice: 0n,
      migrated: false,
    });
    expect(await host.readCurveState({ baseMint: DBC_MINT, curveAddress: null })).toBeNull();
    gateway.pools.set(DBC_MINT, { ...gateway.pools.get(DBC_MINT)!, configAddress: CONFIG });
    expect(
      (await host.readCurveState({ baseMint: DBC_MINT, curveAddress: null }))?.poolAddress,
    ).toBe(POOL);
  });
});

// ── Orchestration: stub listing path ─────────────────────────────────────────

describe('confirmCurve (stub host)', () => {
  function stubHarness(): Harness {
    const h = harness(new FixedRateStubLaunchpad({}, DEVNET_RPC));
    h.tokens.rows.set(REALM, tokenRow(REALM, { mint: PREMINT }));
    h.launches.rows.set(REALM, launchRow(REALM));
    return h;
  }

  it('lists the pre-minted token through the phase 3 verified-locks gate', async () => {
    const h = stubHarness();
    const res = await confirmCurve(h.deps, { accountId: ACCOUNT, realmId: REALM });
    expect(res).toMatchObject({ ok: true, status: 'live', curveAddress: stubCurveAddress(REALM) });
    const token = await h.tokens.getRealmToken(REALM);
    expect(token?.curveAddress).toBe(stubCurveAddress(REALM));
    expect(token?.feeClaimerPda).toBe(realmFeeClaimerPda(REALM));
    expect(token?.status).toBe('live');
  });

  it('blocks listing without verified locks or without a mint', async () => {
    const noLocks = stubHarness();
    noLocks.launches.rows.set(REALM, launchRow(REALM, { locksVerifiedAt: null }));
    expect(await confirmCurve(noLocks.deps, { accountId: ACCOUNT, realmId: REALM })).toMatchObject({
      ok: false,
      status: 409,
      error: 'locks_not_verified',
    });

    const noMint = stubHarness();
    noMint.tokens.rows.set(REALM, tokenRow(REALM, { mint: null }));
    expect(await confirmCurve(noMint.deps, { accountId: ACCOUNT, realmId: REALM })).toMatchObject({
      ok: false,
      status: 409,
      error: 'mint_not_created',
    });
  });

  it('is disabled without a host and guarded on state', async () => {
    const dark = harness(null);
    dark.tokens.rows.set(REALM, tokenRow(REALM));
    expect(await confirmCurve(dark.deps, { accountId: ACCOUNT, realmId: REALM })).toMatchObject({
      ok: false,
      status: 503,
      error: 'launchpad_disabled',
    });

    const h = stubHarness();
    await confirmCurve(h.deps, { accountId: ACCOUNT, realmId: REALM });
    expect(await confirmCurve(h.deps, { accountId: ACCOUNT, realmId: REALM })).toMatchObject({
      ok: false,
      error: 'presale_not_funded', // now live, no longer funded
    });
  });
});

// ── Orchestration: Meteora listing + graduation ──────────────────────────────

function meteoraHarness(over: { owner?: boolean; wallet?: string | null } = {}): Harness {
  const gateway = new FakeGateway();
  const h = harness(new MeteoraDbcLaunchpad(gateway, CONFIG), over);
  h.gateway = gateway;
  (h.deps as { host: Launchpad | null }).host = new MeteoraDbcLaunchpad(gateway, CONFIG);
  h.tokens.rows.set(REALM, tokenRow(REALM));
  return h;
}

describe('prepareCurve (meteora host)', () => {
  it('builds the DBC pool creation for an unminted funded token', async () => {
    const h = meteoraHarness();
    const res = await prepareCurve(h.deps, { accountId: ACCOUNT, realmId: REALM });
    expect(res).toMatchObject({ ok: true, host: 'meteora-dbc', baseMint: DBC_MINT });
  });

  it('rejects a phase 3 pre-minted token on the DBC host', async () => {
    const h = meteoraHarness();
    h.tokens.rows.set(REALM, tokenRow(REALM, { mint: PREMINT }));
    expect(await prepareCurve(h.deps, { accountId: ACCOUNT, realmId: REALM })).toMatchObject({
      ok: false,
      status: 409,
      error: 'host_requires_dbc_mint',
    });
  });

  it('fails closed when the live config breaks a structural guarantee', async () => {
    const h = meteoraHarness();
    h.gateway.config = goodConfig({ partnerLockedLpBps: 0, creatorLockedLpBps: 0 });
    expect(await prepareCurve(h.deps, { accountId: ACCOUNT, realmId: REALM })).toMatchObject({
      ok: false,
      status: 409,
      error: 'lp_not_permanently_locked',
    });
    h.gateway.config = null;
    expect(await prepareCurve(h.deps, { accountId: ACCOUNT, realmId: REALM })).toMatchObject({
      ok: false,
      status: 503,
      error: 'launchpad_config_unreadable',
    });
  });
});

describe('confirmCurve (meteora host)', () => {
  function withPool(h: Harness, over: Partial<CurveState> = {}): void {
    h.gateway.pools.set(DBC_MINT, {
      poolAddress: POOL,
      configAddress: CONFIG,
      baseMint: DBC_MINT,
      creator: FOUNDER,
      quoteReserveBase: 25_000_000_000n,
      sqrtPrice: 123n,
      migrated: false,
      ...over,
    });
  }

  it('verifies the pool binding and lists funded -> live', async () => {
    const h = meteoraHarness();
    withPool(h);
    const res = await confirmCurve(h.deps, {
      accountId: ACCOUNT,
      realmId: REALM,
      baseMint: DBC_MINT,
    });
    expect(res).toMatchObject({ ok: true, status: 'live', curveAddress: POOL });
    const token = await h.tokens.getRealmToken(REALM);
    expect(token?.mint).toBe(DBC_MINT);
    expect(token?.curveAddress).toBe(POOL);
  });

  it('rejects a missing pool, a foreign creator, and a bad mint', async () => {
    const h = meteoraHarness();
    expect(
      await confirmCurve(h.deps, { accountId: ACCOUNT, realmId: REALM, baseMint: 'garbage' }),
    ).toMatchObject({ ok: false, status: 400, error: 'invalid_base_mint' });
    expect(
      await confirmCurve(h.deps, { accountId: ACCOUNT, realmId: REALM, baseMint: DBC_MINT }),
    ).toMatchObject({ ok: false, status: 400, error: 'curve_not_found' });
    withPool(h, { creator: Keypair.generate().publicKey.toBase58() });
    expect(
      await confirmCurve(h.deps, { accountId: ACCOUNT, realmId: REALM, baseMint: DBC_MINT }),
    ).toMatchObject({ ok: false, status: 400, error: 'wrong_curve_creator' });
  });

  it('surfaces migration progress on the curve info read', async () => {
    const h = meteoraHarness();
    withPool(h);
    await confirmCurve(h.deps, { accountId: ACCOUNT, realmId: REALM, baseMint: DBC_MINT });
    const info = await curveInfo(h.deps, { realmId: REALM });
    expect(info.ok).toBe(true);
    if (!info.ok) return;
    // 25 of 100 SOL toward the LIVE threshold: exactly 2500 bps.
    expect(info.curve.curve?.progressBps).toBe(2500);
    expect(info.curve.config?.migrationQuoteThresholdBase).toBe('100000000000');
  });

  it('graduates only when migrated AND the LP is permanently locked', async () => {
    const h = meteoraHarness();
    withPool(h);
    await confirmCurve(h.deps, { accountId: ACCOUNT, realmId: REALM, baseMint: DBC_MINT });

    expect(await confirmGraduation(h.deps, { accountId: ACCOUNT, realmId: REALM })).toMatchObject({
      ok: false,
      status: 409,
      error: 'not_migrated',
    });

    withPool(h, { migrated: true });
    expect(await confirmGraduation(h.deps, { accountId: ACCOUNT, realmId: REALM })).toMatchObject({
      ok: false,
      status: 400,
      error: 'graduation_not_found',
    });

    // Partially locked LP is NOT a graduation.
    h.gateway.graduation = {
      dammPoolAddress: DAMM_POOL,
      liquidity: 1_000_000n,
      permanentLockedLiquidity: 999_999n,
    };
    expect(await confirmGraduation(h.deps, { accountId: ACCOUNT, realmId: REALM })).toMatchObject({
      ok: false,
      status: 409,
      error: 'lp_not_permanently_locked',
    });

    h.gateway.graduation = {
      dammPoolAddress: DAMM_POOL,
      liquidity: 1_000_000n,
      permanentLockedLiquidity: 1_000_000n,
    };
    const res = await confirmGraduation(h.deps, { accountId: ACCOUNT, realmId: REALM });
    expect(res).toMatchObject({ ok: true, status: 'graduated', poolAddress: DAMM_POOL });
    const token = await h.tokens.getRealmToken(REALM);
    expect(token?.status).toBe('graduated');
    expect(token?.poolAddress).toBe(DAMM_POOL);
    expect(token?.lpLockAddress).toBe(DAMM_POOL);
    // A second graduation confirm matches nothing (already graduated).
    expect(await confirmGraduation(h.deps, { accountId: ACCOUNT, realmId: REALM })).toMatchObject({
      ok: false,
      error: 'not_live',
    });
  });
});
