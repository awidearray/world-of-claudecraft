// Launchpad venue seam (launchpad phase 4, PRD sections 5.5 and 7). The
// bonding-curve launch runs behind this thin `LaunchVenue` interface so the
// Meteora DBC integration (realm_launchpad_dbc.ts) is swappable for Raydium
// LaunchLab, and so tests and the pre-mainnet devnet-stub mode run against the
// fixed-rate stub venue below without any chain.
//
// On a curve launch the POOL creates the base mint (that is how a bonding
// curve guarantees the public share actually sells on the curve), so the
// anti-rug allocation from phase 3 maps onto on-chain CONFIG commitments
// instead of post-mint transfers:
//   public curve 60      -> sold on the curve pre-migration
//   liquidity 10         -> deposited into the DAMM v2 pool at migration with
//                           100 percent PERMANENTLY locked LP (nothing
//                           withdrawable; fees remain claimable)
//   founder 12           -> the config's locked vesting, escrowed through the
//                           SAME Jupiter Lock program phase 3 uses, cliff 12
//                           months FROM MIGRATION + 36 monthly periods
//   levy 8 + treasury 10 -> the config's leftover, withdrawable only to the
//                           pinned leftover receiver (the founder) after
//                           migration, then locked through the phase-3
//                           lock-quote flow like a direct launch
// plus an immutable token authority (mint + metadata renounced by
// construction) and a decaying-fee anti-snipe schedule.
//
// Two hard rules from the PRD: the fee claimer is a PDA, NEVER an EOA (an
// off-curve address, ops-owned, e.g. a Squads vault), and every fee/threshold
// the server reports or verifies is READ FROM THE LIVE ON-CHAIN CONFIG, never
// hardcoded: `CurveConfigFacts` is always a normalization of a fetched
// account, and `verifyCurveConfigFacts` compares those live facts against the
// pinned plan.

import { createHash } from 'node:crypto';
import { PublicKey } from '@solana/web3.js';
import {
  allocationBps,
  bucketSchedule,
  computeAllocation,
  SECONDS_PER_MONTH,
  tokenSupplyBase,
} from './realm_token_alloc';
import { isSolanaAddress } from './wallet_link';
import { USDC_MINT } from './woc_config';

// wSOL: the mint a native-SOL-quoted curve settles in.
export const WSOL_MINT = 'So11111111111111111111111111111111111111112';

export type CurveQuoteAsset = 'SOL' | 'USDC';

export function curveQuoteMint(asset: CurveQuoteAsset): { mint: string; decimals: number } {
  return asset === 'SOL' ? { mint: WSOL_MINT, decimals: 9 } : { mint: USDC_MINT, decimals: 6 };
}

function intEnv(key: string, def: number, min: number, max: number): number {
  const v = Number.parseInt(process.env[key] ?? '', 10);
  return Number.isFinite(v) && v >= min && v <= max ? v : def;
}

// ── Env configuration (fail closed) ───────────────────────────────────────────

// The venue switch: unset = curve launches disabled entirely. 'stub' is the
// fixed-rate pre-mainnet host (tests + staging), never a production value.
export type LaunchVenueName = 'meteora_dbc' | 'stub';

export function launchpadVenueName(): LaunchVenueName | null {
  const raw = (process.env.REALM_LAUNCHPAD_VENUE ?? '').trim();
  return raw === 'meteora_dbc' || raw === 'stub' ? raw : null;
}

// The partner fee claimer. MUST be an off-curve address (a PDA, e.g. an ops
// multisig vault): a raw hot wallet as the platform-wide fee drain is exactly
// the key-compromise blast radius the PRD forbids. Fail closed when unset,
// malformed, or on-curve.
export function curveFeeClaimer(): string | null {
  const raw = (process.env.REALM_LAUNCHPAD_FEE_CLAIMER ?? '').trim();
  if (!raw || !isSolanaAddress(raw)) return null;
  try {
    if (PublicKey.isOnCurve(new PublicKey(raw).toBytes())) return null;
    return raw;
  } catch {
    return null;
  }
}

export function curveQuoteAsset(): CurveQuoteAsset {
  return (process.env.REALM_CURVE_QUOTE ?? '').trim() === 'USDC' ? 'USDC' : 'SOL';
}

// Migration threshold in human quote units (SOL or USDC). Read for CONFIG
// CREATION only; every later read of the threshold comes from the live
// on-chain config account.
export function curveMigrationQuoteHuman(): number {
  return intEnv('REALM_CURVE_MIGRATION_QUOTE', 100, 1, 10_000_000);
}

// The anti-snipe decaying-fee schedule + the founder's share of trading fees.
export interface CurveFeePlan {
  startingFeeBps: number;
  endingFeeBps: number;
  numberOfPeriod: number;
  totalDurationSec: number;
  creatorTradingFeePercentage: number;
}

export function curveFeePlan(): CurveFeePlan {
  const endingFeeBps = intEnv('REALM_CURVE_ENDING_FEE_BPS', 100, 10, 1000);
  return {
    startingFeeBps: intEnv('REALM_CURVE_STARTING_FEE_BPS', 2000, endingFeeBps, 5000),
    endingFeeBps,
    numberOfPeriod: intEnv('REALM_CURVE_FEE_PERIODS', 120, 1, 10_000),
    totalDurationSec: intEnv('REALM_CURVE_FEE_DURATION_SEC', 3600, 60, 86_400),
    creatorTradingFeePercentage: intEnv('REALM_CURVE_CREATOR_FEE_PCT', 50, 0, 100),
  };
}

// ── The launch plan (pure) ────────────────────────────────────────────────────

// Everything a curve launch commits to, pinned at quote time and compared
// against the LIVE on-chain config at confirm time. Token amounts are whole
// tokens (the venue configs speak tokens); base-unit equivalents ride along
// for the registry rows.
export interface CurveLaunchPlan {
  quote: CurveQuoteAsset;
  quoteMint: string;
  quoteDecimals: number;
  supplyTokens: number;
  supplyBase: bigint;
  decimals: number;
  publicCurveTokens: number;
  liquidityPercent: number; // percent of supply migrated into the locked LP
  founderVestingTokens: number;
  founderAllocBase: bigint;
  levyAllocBase: bigint;
  treasuryAllocBase: bigint;
  leftoverTokens: number; // levy + treasury, withdrawn post-migration then locked
  vesting: {
    cliffFromMigrationSec: number;
    frequencySec: number;
    numberOfPeriod: number;
  };
  fees: CurveFeePlan;
  migrationQuoteThresholdHuman: number;
  feeClaimer: string;
  leftoverReceiver: string; // the founder wallet
}

// Build the pinned plan from the phase-3 allocation and the curve env knobs.
// Returns null when the launch is unconfigurable (no off-curve fee claimer, or
// a supply that does not split into whole tokens per bps).
export function curveLaunchPlan(founderWallet: string): CurveLaunchPlan | null {
  const feeClaimer = curveFeeClaimer();
  if (feeClaimer === null) return null;

  const supplyBase = tokenSupplyBase();
  const decimals = 9;
  const perToken = 10n ** BigInt(decimals);
  if (supplyBase % perToken !== 0n) return null;
  const supplyTokensBig = supplyBase / perToken;
  // Whole-token bucket splits need supplyTokens divisible by the bps base,
  // and the venue configs take JS numbers, so the supply must sit inside the
  // float-exact integer range.
  if (supplyTokensBig % 10_000n !== 0n) return null;
  if (supplyTokensBig > BigInt(Number.MAX_SAFE_INTEGER)) return null;
  const supplyTokens = Number(supplyTokensBig);

  const bps = allocationBps();
  const alloc = computeAllocation(supplyBase, bps);
  const founderSchedule = bucketSchedule('founder');
  const quote = curveQuoteAsset();
  const { mint: quoteMint, decimals: quoteDecimals } = curveQuoteMint(quote);
  return {
    quote,
    quoteMint,
    quoteDecimals,
    supplyTokens,
    supplyBase,
    decimals,
    publicCurveTokens: Number(alloc.publicCurveBase / perToken),
    liquidityPercent: bps.liquidity / 100,
    founderVestingTokens: Number(alloc.founderBase / perToken),
    founderAllocBase: alloc.founderBase,
    levyAllocBase: alloc.levyBase,
    treasuryAllocBase: alloc.treasuryBase,
    leftoverTokens: Number((alloc.levyBase + alloc.treasuryBase) / perToken),
    vesting: {
      cliffFromMigrationSec: founderSchedule.cliffMonths * SECONDS_PER_MONTH,
      frequencySec: SECONDS_PER_MONTH,
      numberOfPeriod: founderSchedule.vestMonths,
    },
    fees: curveFeePlan(),
    migrationQuoteThresholdHuman: curveMigrationQuoteHuman(),
    feeClaimer,
    leftoverReceiver: founderWallet,
  };
}

// ── Live config facts + verification (pure) ───────────────────────────────────

// A venue's on-chain launch config, normalized. ALWAYS built from a fetched
// account (never from env), so verifying against it proves what the chain
// enforces, not what the server intended.
export interface CurveConfigFacts {
  quoteMint: string;
  feeClaimer: string;
  leftoverReceiver: string;
  tokenType2022: boolean;
  tokenAuthorityImmutable: boolean;
  tokenDecimal: number;
  migrationOptionDammV2: boolean;
  // Percent of the migrated LP that is PERMANENTLY locked / withdrawable,
  // summed across the partner and creator splits. 100 / 0 is the only
  // acceptable shape (nobody can ever pull the liquidity).
  permanentLockedLiquidityPercent: number;
  withdrawableLiquidityPercent: number;
  migrationQuoteThresholdBase: bigint;
  lockedVesting: {
    cliffUnlockBase: bigint;
    amountPerPeriodBase: bigint;
    numberOfPeriod: bigint;
    frequencySec: bigint;
    cliffFromMigrationSec: bigint;
  };
}

export type CurveVerdict = { ok: true } | { ok: false; reason: string };

// Compare the live config facts against the pinned plan. Every failure is the
// same typed code (`curve_mismatch`): the caller's job is only to refuse to
// record, and the panel's job is to tell the founder to start over.
export function verifyCurveConfigFacts(
  facts: CurveConfigFacts,
  plan: CurveLaunchPlan,
): CurveVerdict {
  const bad = { ok: false as const, reason: 'curve_mismatch' };
  if (facts.quoteMint !== plan.quoteMint) return bad;
  if (facts.feeClaimer !== plan.feeClaimer) return bad;
  if (facts.leftoverReceiver !== plan.leftoverReceiver) return bad;
  if (!facts.tokenType2022) return bad;
  if (!facts.tokenAuthorityImmutable) return bad;
  if (facts.tokenDecimal !== plan.decimals) return bad;
  if (!facts.migrationOptionDammV2) return bad;
  if (facts.permanentLockedLiquidityPercent !== 100) return bad;
  if (facts.withdrawableLiquidityPercent !== 0) return bad;
  if (facts.migrationQuoteThresholdBase <= 0n) return bad;
  const v = facts.lockedVesting;
  const totalVestedBase = v.cliffUnlockBase + v.amountPerPeriodBase * v.numberOfPeriod;
  if (totalVestedBase !== plan.founderAllocBase) return bad;
  if (v.frequencySec !== BigInt(plan.vesting.frequencySec)) return bad;
  if (v.numberOfPeriod !== BigInt(plan.vesting.numberOfPeriod)) return bad;
  if (v.cliffFromMigrationSec < BigInt(plan.vesting.cliffFromMigrationSec)) return bad;
  return { ok: true };
}

// ── The venue interface ───────────────────────────────────────────────────────

export interface PreparedCurveLaunch {
  txBase64: string; // config + pool creation, partial-signed by the transient keypairs
  configAddress: string;
  poolAddress: string;
  baseMint: string;
}

export interface CurvePoolState {
  configAddress: string;
  baseMint: string;
  creator: string;
  // Live numbers, straight off the chain.
  sqrtPrice: bigint;
  quoteReserveBase: bigint;
  baseReserveBase: bigint;
  migrationQuoteThresholdBase: bigint;
  // Exact progress in basis points toward the migration threshold, capped for
  // display at 10000.
  progressBps: number;
  isMigrated: boolean;
  isLeftoverWithdrawn: boolean;
  partnerQuoteFeeBase: bigint;
  partnerBaseFeeBase: bigint;
}

export interface CurveMigrationState {
  isMigrated: boolean;
  dammV2Pool: string | null; // exists on chain only after graduation
  lockerEscrow: string | null; // the founder-vesting Jupiter Lock escrow
}

export interface LaunchVenue {
  readonly name: LaunchVenueName;
  prepareCurveLaunch(args: {
    plan: CurveLaunchPlan;
    founderWallet: string;
    symbol: string;
    name: string;
    uri: string;
  }): Promise<PreparedCurveLaunch | null>;
  configFacts(configAddress: string): Promise<CurveConfigFacts | null>;
  poolState(poolAddress: string): Promise<CurvePoolState | null>;
  migrationState(poolAddress: string): Promise<CurveMigrationState | null>;
  // Size-aware quote-out for a base-token sale of `amountBase` against the
  // live curve (phase 6 marks holdings with this, not spot).
  sellQuote(poolAddress: string, amountBase: bigint): Promise<bigint | null>;
  // The post-migration leftover withdrawal (levy + treasury buckets to the
  // config's pinned leftover receiver), unsigned, `payer` pays fees.
  buildWithdrawLeftoverTx(poolAddress: string, payer: string): Promise<string | null>;
}

// Exact progress math shared by venues: quoteReserve / threshold in bps.
export function curveProgressBps(quoteReserveBase: bigint, thresholdBase: bigint): number {
  if (thresholdBase <= 0n) return 0;
  const bps = (quoteReserveBase * 10_000n) / thresholdBase;
  return Number(bps > 10_000n ? 10_000n : bps);
}

// ── The fixed-rate stub venue (tests + pre-mainnet staging) ───────────────────

// Deterministic, chain-free venue: addresses are hashes of the inputs, the
// config facts echo the plan (so verification passes exactly when the plan
// itself is coherent), and the price is a fixed rate. It exists so the whole
// launch flow is drivable end to end before any mainnet transaction.
function stubAddress(...parts: string[]): string {
  const digest = createHash('sha256').update(parts.join('|')).digest();
  return new PublicKey(digest.subarray(0, 32)).toBase58();
}

interface StubPool {
  plan: CurveLaunchPlan;
  configAddress: string;
  baseMint: string;
  creator: string;
  quoteReserveBase: bigint;
  isMigrated: boolean;
  isLeftoverWithdrawn: boolean;
}

export class StubLaunchVenue implements LaunchVenue {
  readonly name = 'stub' as const;
  readonly pools = new Map<string, StubPool>();
  // Fixed rate: 1 base token unit sells for this many quote base units per
  // 10^9 (one whole token = fixedRatePerTokenBase quote base units).
  fixedRatePerTokenBase = 1_000n;

  async prepareCurveLaunch(args: {
    plan: CurveLaunchPlan;
    founderWallet: string;
    symbol: string;
    name: string;
    uri: string;
  }): Promise<PreparedCurveLaunch | null> {
    const configAddress = stubAddress('config', args.founderWallet, args.symbol);
    const poolAddress = stubAddress('pool', configAddress);
    const baseMint = stubAddress('mint', configAddress);
    this.pools.set(poolAddress, {
      plan: args.plan,
      configAddress,
      baseMint,
      creator: args.founderWallet,
      quoteReserveBase: 0n,
      isMigrated: false,
      isLeftoverWithdrawn: false,
    });
    // The stub "transaction" is a marker, never sendable; the stub confirm
    // path never touches a chain.
    const txBase64 = Buffer.from(`stub-launch:${poolAddress}`, 'utf8').toString('base64');
    return { txBase64, configAddress, poolAddress, baseMint };
  }

  private byConfig(configAddress: string): StubPool | null {
    for (const pool of this.pools.values()) {
      if (pool.configAddress === configAddress) return pool;
    }
    return null;
  }

  async configFacts(configAddress: string): Promise<CurveConfigFacts | null> {
    const pool = this.byConfig(configAddress);
    if (!pool) return null;
    const p = pool.plan;
    const perPeriod = p.founderAllocBase / BigInt(p.vesting.numberOfPeriod);
    return {
      quoteMint: p.quoteMint,
      feeClaimer: p.feeClaimer,
      leftoverReceiver: p.leftoverReceiver,
      tokenType2022: true,
      tokenAuthorityImmutable: true,
      tokenDecimal: p.decimals,
      migrationOptionDammV2: true,
      permanentLockedLiquidityPercent: 100,
      withdrawableLiquidityPercent: 0,
      migrationQuoteThresholdBase:
        BigInt(p.migrationQuoteThresholdHuman) * 10n ** BigInt(p.quoteDecimals),
      lockedVesting: {
        cliffUnlockBase: p.founderAllocBase - perPeriod * BigInt(p.vesting.numberOfPeriod),
        amountPerPeriodBase: perPeriod,
        numberOfPeriod: BigInt(p.vesting.numberOfPeriod),
        frequencySec: BigInt(p.vesting.frequencySec),
        cliffFromMigrationSec: BigInt(p.vesting.cliffFromMigrationSec),
      },
    };
  }

  async poolState(poolAddress: string): Promise<CurvePoolState | null> {
    const pool = this.pools.get(poolAddress);
    if (!pool) return null;
    const threshold =
      BigInt(pool.plan.migrationQuoteThresholdHuman) * 10n ** BigInt(pool.plan.quoteDecimals);
    return {
      configAddress: pool.configAddress,
      baseMint: pool.baseMint,
      creator: pool.creator,
      sqrtPrice: 0n,
      quoteReserveBase: pool.quoteReserveBase,
      baseReserveBase: pool.plan.supplyBase,
      migrationQuoteThresholdBase: threshold,
      progressBps: curveProgressBps(pool.quoteReserveBase, threshold),
      isMigrated: pool.isMigrated,
      isLeftoverWithdrawn: pool.isLeftoverWithdrawn,
      partnerQuoteFeeBase: 0n,
      partnerBaseFeeBase: 0n,
    };
  }

  async migrationState(poolAddress: string): Promise<CurveMigrationState | null> {
    const pool = this.pools.get(poolAddress);
    if (!pool) return null;
    return {
      isMigrated: pool.isMigrated,
      dammV2Pool: pool.isMigrated ? stubAddress('damm', poolAddress) : null,
      lockerEscrow: pool.isMigrated ? stubAddress('locker', poolAddress) : null,
    };
  }

  async sellQuote(poolAddress: string, amountBase: bigint): Promise<bigint | null> {
    if (!this.pools.has(poolAddress)) return null;
    return (amountBase * this.fixedRatePerTokenBase) / 10n ** 9n;
  }

  async buildWithdrawLeftoverTx(poolAddress: string, payer: string): Promise<string | null> {
    if (!this.pools.has(poolAddress)) return null;
    return Buffer.from(`stub-leftover:${poolAddress}:${payer}`, 'utf8').toString('base64');
  }
}
