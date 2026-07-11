// Bonding-curve launch service (launchpad phase 4, PRD section 5.5): a thin
// Launchpad seam over the curve host so Meteora DBC is an integration, not a
// hard dependency, and a Raydium LaunchLab adapter stays a drop-in.
//
// Two hosts:
//  - `meteora-dbc` (production): wraps @meteora-ag/dynamic-bonding-curve-sdk.
//    The partner config is read LIVE from the chain on every decision (fees,
//    quote mint, migration threshold, LP-lock percentages: NEVER hardcoded).
//    Pool creation builds the SDK's createPool transaction with a TRANSIENT
//    base-mint keypair partial-signing (the DBC program creates the token and
//    mints the curve supply itself; the founder co-signs and pays). Listing is
//    gated on the config's STRUCTURAL guarantees verified on-chain: DAMM v2
//    migration with the LP fully permanently locked, and a locked-vesting
//    (Jupiter Locker) creator schedule. Graduation is verified against the
//    live DAMM v2 pool's permanent-lock liquidity.
//  - `fixed-rate-stub` (devnet/e2e, PRD "fixed-rate stub host"): no chain
//    writes, REFUSES to run against mainnet, and lists the phase 3 pre-minted
//    token only through the phase 3 gate (mint confirmed + all three Jupiter
//    Locks verified). A stub never graduates.
//
// MAINNET GATE: phase 4's acceptance check is a mainnet dry-run that needs the
// owner's explicit sign-off. Everything here is buildable and testable without
// one; the whole surface is additionally flag-gated OFF by default
// (REALM_LAUNCHPAD_ENABLED). The server signs nothing on this path beyond the
// transient base-mint keypair inside prepare (discarded in-call).
//
// No SQL here (realm_token_db.ts owns the curve/graduation writes).

import { PublicKey } from '@solana/web3.js';
import { REALM_ESCROW_PROGRAM_ID } from './realm_escrow';
import { fail, type RealmToken, type RealmTokenDb, type Result } from './realm_token';
import type { RealmTokenLaunch, RealmTokenLaunchStore } from './realm_token_mint';
import { launchReadyToList, listRealmToken } from './realm_token_mint';
import { SOLANA_RPC_URL } from './solana_rpc';
import { isSolanaAddress } from './wallet_link';

// ── Per-realm fee-claimer PDA ────────────────────────────────────────────────

// The per-realm fee identity is a PDA of the (already deployed) realm escrow
// program, so it can never be an EOA with a private key: no person can sign as
// it. It anchors per-realm fee attribution on-chain (the partner-level DBC
// feeClaimer is platform ops configuration, read live from the config).
export function realmFeeClaimerPda(realmId: number): string {
  const seed = Buffer.alloc(8);
  seed.writeBigUInt64LE(BigInt(realmId));
  return PublicKey.findProgramAddressSync(
    [Buffer.from('realm-fee-claimer'), seed],
    REALM_ESCROW_PROGRAM_ID,
  )[0].toBase58();
}

// ── Launchpad seam ───────────────────────────────────────────────────────────

export type LaunchpadKind = 'meteora-dbc' | 'fixed-rate-stub';

// The live partner-config snapshot every decision reads (never hardcoded).
export interface LaunchpadPartnerConfig {
  configAddress: string;
  quoteMint: string; // '' = native SOL
  feeClaimer: string;
  migrationQuoteThresholdBase: bigint;
  migrationOption: number; // 0 = DAMM v1, 1 = DAMM v2
  tokenType: number; // 0 = SPL, 1 = Token-2022
  partnerLockedLpBps: number;
  creatorLockedLpBps: number;
  // A non-default locked-vesting schedule exists (the DBC creates it through
  // the Jupiter Locker program at migration).
  lockedVestingPresent: boolean;
}

export interface CurveState {
  poolAddress: string;
  configAddress: string;
  baseMint: string;
  creator: string;
  quoteReserveBase: bigint;
  sqrtPrice: bigint;
  migrated: boolean;
}

export interface GraduationState {
  dammPoolAddress: string;
  liquidity: bigint;
  permanentLockedLiquidity: bigint;
}

export interface PreparedCurve {
  // Base64 partial-signed transaction the founder co-signs, or null when the
  // host needs no chain write (the stub).
  txBase64: string | null;
  baseMint: string;
}

export interface Launchpad {
  kind: LaunchpadKind;
  readPartnerConfig(): Promise<LaunchpadPartnerConfig | null>;
  prepareCurvePool(args: {
    realmId: number;
    founderWallet: string;
    name: string;
    symbol: string;
    uri: string;
    // The phase 3 pre-minted token, when one exists (required by the stub,
    // rejected by the DBC host, which mints its own).
    premintedMint: string | null;
  }): Promise<PreparedCurve | null>;
  readCurveState(args: {
    baseMint: string;
    curveAddress: string | null;
  }): Promise<CurveState | null>;
  readGraduation(args: { baseMint: string; quoteMint: string }): Promise<GraduationState | null>;
}

// ── Pure math + config verdicts ──────────────────────────────────────────────

// Exact progress toward the migration threshold in basis points, capped at
// 10000 for display. Threshold 0 (unreadable/absent) reads as no progress.
export function migrationProgressBps(quoteReserveBase: bigint, thresholdBase: bigint): number {
  if (thresholdBase <= 0n) return 0;
  const bps = (quoteReserveBase * 10_000n) / thresholdBase;
  return Number(bps > 10_000n ? 10_000n : bps);
}

export type ConfigGuaranteeIssue =
  | 'not_damm_v2'
  | 'lp_not_permanently_locked'
  | 'no_locked_vesting'
  | 'no_migration_threshold';

// The structural anti-rug guarantees a DBC partner config must carry before a
// realm token may list through it (PRD section 7): DAMM v2 graduation, 100
// percent of the LP permanently locked (partner + creator shares), a
// locked-vesting schedule, and a real migration threshold. Read from the LIVE
// config, so a quietly re-issued config fails listing rather than trading.
export function configGuaranteeIssues(
  config: LaunchpadPartnerConfig,
  minLockedLpBps: number,
): ConfigGuaranteeIssue[] {
  const issues: ConfigGuaranteeIssue[] = [];
  if (config.migrationOption !== 1) issues.push('not_damm_v2');
  if (config.partnerLockedLpBps + config.creatorLockedLpBps < minLockedLpBps) {
    issues.push('lp_not_permanently_locked');
  }
  if (!config.lockedVestingPresent) issues.push('no_locked_vesting');
  if (config.migrationQuoteThresholdBase <= 0n) issues.push('no_migration_threshold');
  return issues;
}

// The minimum permanently-locked LP share, in bps of the whole LP. Defaults to
// the full 10000 ("permanently locked liquidity" means all of it); an operator
// may only lower it deliberately.
export function minLockedLpBps(env: Record<string, string | undefined> = process.env): number {
  const raw = env.REALM_LP_LOCK_MIN_BPS;
  if (raw === undefined || !/^[0-9]{1,5}$/.test(raw.trim())) return 10_000;
  const n = Number.parseInt(raw, 10);
  return n >= 1 && n <= 10_000 ? n : 10_000;
}

// ── Fixed-rate stub host (devnet/e2e only) ───────────────────────────────────

const MAINNET_RPC = /mainnet/i;

export function stubCurveAddress(realmId: number): string {
  return `stub-curve-${realmId}`;
}

// The PRD's "fixed-rate stub host": lets the full listing pipeline run against
// devnet or a local validator with the phase 3 pre-minted token, without a
// bonding-curve program. It refuses mainnet outright and never graduates.
export class FixedRateStubLaunchpad implements Launchpad {
  readonly kind = 'fixed-rate-stub' as const;
  constructor(
    private readonly env: Record<string, string | undefined> = process.env,
    private readonly rpcUrl: string = SOLANA_RPC_URL,
  ) {}

  private thresholdBase(): bigint {
    const raw = this.env.REALM_STUB_MIGRATION_THRESHOLD_BASE;
    if (raw !== undefined && /^[0-9]{1,20}$/.test(raw.trim())) return BigInt(raw.trim());
    return 100n * 10n ** 9n; // 100 SOL in lamports
  }

  private mainnet(): boolean {
    return MAINNET_RPC.test(this.rpcUrl);
  }

  async readPartnerConfig(): Promise<LaunchpadPartnerConfig | null> {
    if (this.mainnet()) return null;
    return {
      configAddress: 'stub-config',
      quoteMint: '',
      feeClaimer: 'stub-fee-claimer',
      migrationQuoteThresholdBase: this.thresholdBase(),
      migrationOption: 1,
      tokenType: 1,
      partnerLockedLpBps: 10_000,
      creatorLockedLpBps: 0,
      lockedVestingPresent: true,
    };
  }

  async prepareCurvePool(args: {
    realmId: number;
    premintedMint: string | null;
  }): Promise<PreparedCurve | null> {
    if (this.mainnet() || args.premintedMint === null) return null;
    return { txBase64: null, baseMint: args.premintedMint };
  }

  async readCurveState(args: {
    baseMint: string;
    curveAddress: string | null;
  }): Promise<CurveState | null> {
    if (this.mainnet() || !args.curveAddress?.startsWith('stub-curve-')) return null;
    return {
      poolAddress: args.curveAddress,
      configAddress: 'stub-config',
      baseMint: args.baseMint,
      creator: '',
      quoteReserveBase: 0n,
      sqrtPrice: 0n,
      migrated: false,
    };
  }

  async readGraduation(): Promise<GraduationState | null> {
    return null; // a stub never graduates; graduation is mainnet-only by design
  }
}

// ── Meteora DBC host ─────────────────────────────────────────────────────────

// The narrow chain surface the Meteora adapter consumes; the SDK binding lives
// in realm_launchpad_dbc.ts so unit tests drive the adapter with fixtures and
// the SDK stays out of the test path.
export interface DbcGateway {
  getPoolConfig(configAddress: string): Promise<LaunchpadPartnerConfig | null>;
  getPoolByBaseMint(baseMint: string): Promise<CurveState | null>;
  // Build the createPool transaction, partial-signed by the transient base
  // mint keypair the gateway generates; the founder is payer + poolCreator.
  buildCreatePoolTx(args: {
    configAddress: string;
    payer: string;
    poolCreator: string;
    name: string;
    symbol: string;
    uri: string;
  }): Promise<{ txBase64: string; baseMint: string } | null>;
  getDammV2PoolLock(args: { baseMint: string; quoteMint: string }): Promise<GraduationState | null>;
}

export class MeteoraDbcLaunchpad implements Launchpad {
  readonly kind = 'meteora-dbc' as const;
  constructor(
    private readonly gateway: DbcGateway,
    private readonly configAddress: string,
  ) {}

  readPartnerConfig(): Promise<LaunchpadPartnerConfig | null> {
    return this.gateway.getPoolConfig(this.configAddress);
  }

  async prepareCurvePool(args: {
    realmId: number;
    founderWallet: string;
    name: string;
    symbol: string;
    uri: string;
    premintedMint: string | null;
  }): Promise<PreparedCurve | null> {
    // The DBC program creates the token itself (the base mint signs pool
    // creation); a pre-minted phase 3 token cannot enter a DBC pool.
    if (args.premintedMint !== null) return null;
    const built = await this.gateway.buildCreatePoolTx({
      configAddress: this.configAddress,
      payer: args.founderWallet,
      poolCreator: args.founderWallet,
      name: args.name,
      symbol: args.symbol,
      uri: args.uri,
    });
    return built ? { txBase64: built.txBase64, baseMint: built.baseMint } : null;
  }

  async readCurveState(args: {
    baseMint: string;
    curveAddress: string | null;
  }): Promise<CurveState | null> {
    const state = await this.gateway.getPoolByBaseMint(args.baseMint);
    // Only pools under OUR live partner config count: a pool someone created
    // under a different config carries none of the verified guarantees.
    return state && state.configAddress === this.configAddress ? state : null;
  }

  readGraduation(args: { baseMint: string; quoteMint: string }): Promise<GraduationState | null> {
    return this.gateway.getDammV2PoolLock(args);
  }
}

// ── Host resolution (flag-gated, default OFF) ────────────────────────────────

export interface HostFactoryDeps {
  env?: Record<string, string | undefined>;
  liveGateway?: () => DbcGateway;
}

// The launch surface is dark until ops flips REALM_LAUNCHPAD_ENABLED=1 (the
// same fail-closed posture as the wager features): phase 4's mainnet dry-run
// needs the owner's explicit sign-off before this is ever enabled anywhere
// real. Host selection: 'meteora' (needs REALM_DBC_CONFIG) or 'stub'.
export function realmLaunchpadHost(deps: HostFactoryDeps = {}): Launchpad | null {
  const env = deps.env ?? process.env;
  if ((env.REALM_LAUNCHPAD_ENABLED ?? '').trim() !== '1') return null;
  const host = (env.REALM_LAUNCHPAD_HOST ?? 'meteora').trim();
  if (host === 'stub') return new FixedRateStubLaunchpad(env);
  if (host !== 'meteora') return null;
  const config = (env.REALM_DBC_CONFIG ?? '').trim();
  if (!isSolanaAddress(config) || !deps.liveGateway) return null;
  return new MeteoraDbcLaunchpad(deps.liveGateway(), config);
}

// ── Orchestration ────────────────────────────────────────────────────────────

export interface CurveDeps {
  tokens: RealmTokenDb;
  launches: RealmTokenLaunchStore;
  host: Launchpad | null;
  walletForAccount(accountId: number): Promise<{ pubkey: string } | null>;
  rolesForAccountOnRealm(realmId: number, accountId: number): Promise<string[]>;
  // SQL (realm_token_db.ts): record listing / graduation.
  recordCurveListed(
    realmId: number,
    fields: { mint: string; curveAddress: string; feeClaimerPda: string },
  ): Promise<boolean>;
  recordGraduation(
    realmId: number,
    fields: { poolAddress: string; lpLockAddress: string },
  ): Promise<RealmToken | null>;
}

export interface CurveInfoResponse {
  host: LaunchpadKind | null;
  config: {
    quoteMint: string;
    migrationQuoteThresholdBase: string;
    partnerLockedLpBps: number;
    creatorLockedLpBps: number;
  } | null;
  curve: {
    poolAddress: string;
    quoteReserveBase: string;
    progressBps: number;
    migrated: boolean;
  } | null;
  graduated: boolean;
  poolAddress: string | null;
  lpLockAddress: string | null;
}

// The curve panel read: live config + live curve state + migration progress.
export async function curveInfo(
  deps: CurveDeps,
  args: { realmId: number },
): Promise<Result<{ curve: CurveInfoResponse }>> {
  const token = await deps.tokens.getRealmToken(args.realmId);
  if (!token) return fail(404, 'token_not_registered');
  if (!deps.host) return fail(503, 'launchpad_disabled');
  const config = await deps.host.readPartnerConfig();
  let curve: CurveInfoResponse['curve'] = null;
  if (token.mint && token.curveAddress) {
    const state = await deps.host.readCurveState({
      baseMint: token.mint,
      curveAddress: token.curveAddress,
    });
    if (state) {
      curve = {
        poolAddress: state.poolAddress,
        quoteReserveBase: state.quoteReserveBase.toString(),
        progressBps: migrationProgressBps(
          state.quoteReserveBase,
          config?.migrationQuoteThresholdBase ?? 0n,
        ),
        migrated: state.migrated,
      };
    }
  }
  return {
    ok: true,
    curve: {
      host: deps.host.kind,
      config: config
        ? {
            quoteMint: config.quoteMint,
            migrationQuoteThresholdBase: config.migrationQuoteThresholdBase.toString(),
            partnerLockedLpBps: config.partnerLockedLpBps,
            creatorLockedLpBps: config.creatorLockedLpBps,
          }
        : null,
      curve,
      graduated: token.status === 'graduated',
      poolAddress: token.poolAddress,
      lpLockAddress: token.lpLockAddress,
    },
  };
}

export interface CurvePrepareResponse {
  txBase64: string | null;
  baseMint: string;
  host: LaunchpadKind;
}

// Owner opens the curve. Meteora: builds the DBC createPool transaction (the
// live config's guarantees must verify first); stub: binds the phase 3 mint.
export async function prepareCurve(
  deps: CurveDeps,
  args: { accountId: number; realmId: number; name?: string; uri?: string },
): Promise<Result<CurvePrepareResponse>> {
  const roles = await deps.rolesForAccountOnRealm(args.realmId, args.accountId);
  if (!roles.includes('owner')) return fail(403, 'not_realm_owner');
  const token = await deps.tokens.getRealmToken(args.realmId);
  if (!token) return fail(404, 'token_not_registered');
  if (!deps.host) return fail(503, 'launchpad_disabled');
  if (token.status !== 'funded') return fail(409, 'presale_not_funded');
  if (token.curveAddress !== null) return fail(409, 'curve_already_created');
  const founder = await deps.walletForAccount(args.accountId);
  if (!founder) return fail(400, 'wallet_not_linked');

  const config = await deps.host.readPartnerConfig();
  if (!config) return fail(503, 'launchpad_config_unreadable');
  const issues = configGuaranteeIssues(config, minLockedLpBps());
  if (issues.length > 0) return fail(409, issues[0]);

  if (deps.host.kind === 'fixed-rate-stub') {
    // The stub lists the phase 3 pre-minted token: the full lock pipeline must
    // already be verified (the PRD listing gate).
    const launch = await deps.launches.getLaunch(args.realmId);
    if (!launch || token.mint === null || launch.locksVerifiedAt === null) {
      return fail(409, 'locks_not_verified');
    }
  } else if (token.mint !== null) {
    // The DBC creates its own token; a phase 3 pre-minted token cannot enter
    // a DBC pool (resolve the launch mode before minting).
    return fail(409, 'host_requires_dbc_mint');
  }

  const name = (args.name ?? token.symbol).trim();
  const uri = (args.uri ?? '').trim();
  const prepared = await deps.host.prepareCurvePool({
    realmId: args.realmId,
    founderWallet: founder.pubkey,
    name,
    symbol: token.symbol,
    uri,
    premintedMint: token.mint,
  });
  if (!prepared) return fail(503, 'launchpad_config_unreadable');
  return {
    ok: true,
    txBase64: prepared.txBase64,
    baseMint: prepared.baseMint,
    host: deps.host.kind,
  };
}

// Confirm the curve exists on-chain and list the token (funded -> live).
// Meteora: the pool must sit under OUR live config (with its structural
// guarantees re-verified) and be created by the founder wallet. Stub: the
// phase 3 listing gate (verified locks + the curve just bound) applies.
export async function confirmCurve(
  deps: CurveDeps,
  args: { accountId: number; realmId: number; baseMint?: string },
): Promise<Result<{ status: RealmToken['status']; curveAddress: string }>> {
  const roles = await deps.rolesForAccountOnRealm(args.realmId, args.accountId);
  if (!roles.includes('owner')) return fail(403, 'not_realm_owner');
  const token = await deps.tokens.getRealmToken(args.realmId);
  if (!token) return fail(404, 'token_not_registered');
  if (!deps.host) return fail(503, 'launchpad_disabled');
  if (token.status !== 'funded') return fail(409, 'presale_not_funded');
  if (token.curveAddress !== null) return fail(409, 'curve_already_created');

  if (deps.host.kind === 'fixed-rate-stub') {
    if (token.mint === null) return fail(409, 'mint_not_created');
    const launch = await deps.launches.getLaunch(args.realmId);
    if (!launch || launch.locksVerifiedAt === null) return fail(409, 'locks_not_verified');
    const curveAddress = stubCurveAddress(args.realmId);
    if (
      !(await deps.recordCurveListed(args.realmId, {
        mint: token.mint,
        curveAddress,
        feeClaimerPda: realmFeeClaimerPda(args.realmId),
      }))
    ) {
      return fail(409, 'curve_already_created');
    }
    // The phase 3 gate does the funded -> live flip (locks + curve present).
    const listed = await listRealmToken(
      { tokens: deps.tokens, launches: deps.launches },
      args.realmId,
    );
    if (!listed.ok) return listed;
    return { ok: true, status: listed.status, curveAddress };
  }

  // Meteora: re-verify the live config guarantees at the listing moment.
  const config = await deps.host.readPartnerConfig();
  if (!config) return fail(503, 'launchpad_config_unreadable');
  const issues = configGuaranteeIssues(config, minLockedLpBps());
  if (issues.length > 0) return fail(409, issues[0]);

  const baseMint = (args.baseMint ?? '').trim();
  if (!isSolanaAddress(baseMint)) return fail(400, 'invalid_base_mint');
  const founder = await deps.walletForAccount(args.accountId);
  if (!founder) return fail(400, 'wallet_not_linked');
  const state = await deps.host.readCurveState({ baseMint, curveAddress: null });
  if (!state) return fail(400, 'curve_not_found');
  if (state.creator !== founder.pubkey) return fail(400, 'wrong_curve_creator');

  if (
    !(await deps.recordCurveListed(args.realmId, {
      mint: baseMint,
      curveAddress: state.poolAddress,
      feeClaimerPda: realmFeeClaimerPda(args.realmId),
    }))
  ) {
    return fail(409, 'curve_already_created');
  }
  const flipped = await deps.tokens.setRealmTokenStatus(args.realmId, ['funded'], 'live');
  if (!flipped) return fail(409, 'not_listable');
  return { ok: true, status: flipped.status, curveAddress: state.poolAddress };
}

// Verify graduation: the curve reports migrated AND the DAMM v2 pool's
// liquidity is permanently locked at (or above) the required share. Flips
// live -> graduated and pins the pool + lock proof addresses.
export async function confirmGraduation(
  deps: CurveDeps,
  args: { accountId: number; realmId: number },
): Promise<Result<{ status: RealmToken['status']; poolAddress: string }>> {
  const roles = await deps.rolesForAccountOnRealm(args.realmId, args.accountId);
  if (!roles.includes('owner')) return fail(403, 'not_realm_owner');
  const token = await deps.tokens.getRealmToken(args.realmId);
  if (!token) return fail(404, 'token_not_registered');
  if (!deps.host) return fail(503, 'launchpad_disabled');
  if (token.status !== 'live') return fail(409, 'not_live');
  if (token.mint === null || token.curveAddress === null) return fail(409, 'curve_not_found');

  const config = await deps.host.readPartnerConfig();
  if (!config) return fail(503, 'launchpad_config_unreadable');
  const state = await deps.host.readCurveState({
    baseMint: token.mint,
    curveAddress: token.curveAddress,
  });
  if (!state) return fail(400, 'curve_not_found');
  if (!state.migrated) return fail(409, 'not_migrated');

  const graduation = await deps.host.readGraduation({
    baseMint: token.mint,
    quoteMint: config.quoteMint,
  });
  if (!graduation) return fail(400, 'graduation_not_found');
  const lockedBps =
    graduation.liquidity > 0n
      ? Number((graduation.permanentLockedLiquidity * 10_000n) / graduation.liquidity)
      : 0;
  if (lockedBps < minLockedLpBps()) return fail(409, 'lp_not_permanently_locked');

  const updated = await deps.recordGraduation(args.realmId, {
    poolAddress: graduation.dammPoolAddress,
    lpLockAddress: graduation.dammPoolAddress,
  });
  if (!updated) return fail(409, 'not_live');
  return { ok: true, status: updated.status, poolAddress: graduation.dammPoolAddress };
}

export type { RealmTokenLaunch };
// Re-exported so the routes can gate on phase 3 readiness without importing
// the factory module twice.
export { launchReadyToList };
