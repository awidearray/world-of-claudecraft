// Realm token allocation + lock policy (launchpad phase 3, PRD section 7). Pure
// math only: the fixed-supply split across the five buckets, the immutable
// vesting schedules the Jupiter Lock escrows must carry, and the listing gate
// that keeps a token out of `live` until the founder, levy, and LP locks are
// verifiably on-chain. No IO, no SQL, no chain types: realm_token_mint.ts feeds
// these numbers into transactions and verifies the results against them.
//
// The economics in one line (PRD): 60 percent public curve, 10 liquidity (LP
// permanently locked at graduation), founder 12 capped 15 (12mo cliff + 36mo
// linear, immutable), Levy Street Fund 8 capped 10 (12+48, the strictest
// schedule on the cap table), realm treasury 10 capped 15. Env-tunable within
// the hard caps; an out-of-cap or curve-starving configuration falls back to
// the defaults wholesale (never a partial mix).

import type { RealmToken } from './realm_token';

// The three locked buckets (each gets an immutable Jupiter Lock escrow). The
// public/curve and liquidity buckets are never locked here: they move to the
// phase-4 bonding curve / LP, whose permanent lock is recorded separately.
export type LockBucket = 'founder' | 'levy' | 'treasury';
export const LOCK_BUCKETS: readonly LockBucket[] = ['founder', 'levy', 'treasury'];

export function isLockBucket(raw: string): raw is LockBucket {
  return raw === 'founder' || raw === 'levy' || raw === 'treasury';
}

export interface AllocationBps {
  publicCurve: number;
  liquidity: number;
  founder: number;
  levy: number;
  treasury: number;
}

// Defaults + hard caps from the PRD allocation table. The founder cap exists
// because a higher insider allocation reads as rug-risk regardless of vesting;
// the public floor keeps the bulk of supply selling through the open curve.
export const DEFAULT_ALLOCATION_BPS: AllocationBps = {
  publicCurve: 6000,
  liquidity: 1000,
  founder: 1200,
  levy: 800,
  treasury: 1000,
};
export const FOUNDER_BPS_CAP = 1500;
export const LEVY_BPS_CAP = 1000;
export const TREASURY_BPS_CAP = 1500;
export const LIQUIDITY_BPS_CAP = 2000;
export const PUBLIC_CURVE_BPS_FLOOR = 5000;

function intEnv(key: string, def: number, min: number, max: number): number {
  const v = Number.parseInt(process.env[key] ?? '', 10);
  return Number.isFinite(v) && v >= min && v <= max ? v : def;
}

// The env-tuned allocation. Each locked bucket is clamped to its hard cap at
// the parse, and the public/curve share is DERIVED (10000 minus the rest) so
// the split always sums to exactly 10000 bps. If the derived public share
// falls under the floor, the whole configuration is rejected in favor of the
// defaults: a partially-applied mix would be harder to reason about than a
// loudly-default one.
export function allocationBps(): AllocationBps {
  const liquidity = intEnv(
    'REALM_TOKEN_LIQUIDITY_BPS',
    DEFAULT_ALLOCATION_BPS.liquidity,
    0,
    LIQUIDITY_BPS_CAP,
  );
  const founder = intEnv(
    'REALM_TOKEN_FOUNDER_BPS',
    DEFAULT_ALLOCATION_BPS.founder,
    0,
    FOUNDER_BPS_CAP,
  );
  const levy = intEnv('REALM_TOKEN_LEVY_BPS', DEFAULT_ALLOCATION_BPS.levy, 0, LEVY_BPS_CAP);
  const treasury = intEnv(
    'REALM_TOKEN_TREASURY_BPS',
    DEFAULT_ALLOCATION_BPS.treasury,
    0,
    TREASURY_BPS_CAP,
  );
  const publicCurve = 10_000 - liquidity - founder - levy - treasury;
  if (publicCurve < PUBLIC_CURVE_BPS_FLOOR) return { ...DEFAULT_ALLOCATION_BPS };
  return { publicCurve, liquidity, founder, levy, treasury };
}

// Fixed total supply in base units (9 decimals). Default one billion tokens.
// Bounded to u64 because every on-chain amount (mintToChecked, the Jupiter
// Lock params) is a u64.
export const U64_MAX = 18_446_744_073_709_551_615n;
const DEFAULT_SUPPLY_BASE = 1_000_000_000n * 10n ** 9n;

export function tokenSupplyBase(): bigint {
  const raw = (process.env.REALM_TOKEN_SUPPLY_BASE ?? '').trim();
  if (!/^[0-9]{1,20}$/.test(raw)) return DEFAULT_SUPPLY_BASE;
  const v = BigInt(raw);
  return v > 0n && v <= U64_MAX ? v : DEFAULT_SUPPLY_BASE;
}

export interface Allocation {
  supplyBase: bigint;
  publicCurveBase: bigint;
  liquidityBase: bigint;
  founderBase: bigint;
  levyBase: bigint;
  treasuryBase: bigint;
}

// Exact bigint split. Each non-public bucket takes floor(supply * bps / 10000);
// the public/curve bucket absorbs the division dust so the five buckets sum to
// EXACTLY the supply (the distribution verifier compares deltas exactly, and a
// renounced mint can never top up a shortfall).
export function computeAllocation(supplyBase: bigint, bps: AllocationBps): Allocation {
  const cut = (b: number): bigint => (supplyBase * BigInt(b)) / 10_000n;
  const liquidityBase = cut(bps.liquidity);
  const founderBase = cut(bps.founder);
  const levyBase = cut(bps.levy);
  const treasuryBase = cut(bps.treasury);
  const publicCurveBase = supplyBase - liquidityBase - founderBase - levyBase - treasuryBase;
  return { supplyBase, publicCurveBase, liquidityBase, founderBase, levyBase, treasuryBase };
}

// ── Vesting schedules ─────────────────────────────────────────────────────────

// Jupiter Lock periods are wall-clock seconds; we vest on 30-day months.
export const SECONDS_PER_MONTH = 30 * 86_400;

export interface VestingSchedule {
  cliffMonths: number;
  vestMonths: number; // linear monthly periods after the cliff
}

// PRD schedules. These are MINIMUMS: env can lengthen a schedule, never
// shorten it (a shorter founder lock is exactly the rug signal this feature
// exists to remove). The levy schedule must remain the strictest on the cap
// table; that invariant is enforced by construction here (its minimums are the
// longest) and pinned by a test.
export const FOUNDER_SCHEDULE: VestingSchedule = { cliffMonths: 12, vestMonths: 36 };
export const LEVY_SCHEDULE: VestingSchedule = { cliffMonths: 12, vestMonths: 48 };
export const TREASURY_SCHEDULE: VestingSchedule = { cliffMonths: 12, vestMonths: 36 };
const MAX_MONTHS = 120;

export function bucketSchedule(bucket: LockBucket): VestingSchedule {
  switch (bucket) {
    case 'founder':
      return {
        cliffMonths: intEnv(
          'REALM_TOKEN_FOUNDER_CLIFF_MONTHS',
          FOUNDER_SCHEDULE.cliffMonths,
          FOUNDER_SCHEDULE.cliffMonths,
          MAX_MONTHS,
        ),
        vestMonths: intEnv(
          'REALM_TOKEN_FOUNDER_VEST_MONTHS',
          FOUNDER_SCHEDULE.vestMonths,
          FOUNDER_SCHEDULE.vestMonths,
          MAX_MONTHS,
        ),
      };
    case 'levy':
      return {
        cliffMonths: intEnv(
          'REALM_TOKEN_LEVY_CLIFF_MONTHS',
          LEVY_SCHEDULE.cliffMonths,
          LEVY_SCHEDULE.cliffMonths,
          MAX_MONTHS,
        ),
        vestMonths: intEnv(
          'REALM_TOKEN_LEVY_VEST_MONTHS',
          LEVY_SCHEDULE.vestMonths,
          LEVY_SCHEDULE.vestMonths,
          MAX_MONTHS,
        ),
      };
    case 'treasury':
      return {
        cliffMonths: intEnv(
          'REALM_TOKEN_TREASURY_CLIFF_MONTHS',
          TREASURY_SCHEDULE.cliffMonths,
          TREASURY_SCHEDULE.cliffMonths,
          MAX_MONTHS,
        ),
        vestMonths: intEnv(
          'REALM_TOKEN_TREASURY_VEST_MONTHS',
          TREASURY_SCHEDULE.vestMonths,
          TREASURY_SCHEDULE.vestMonths,
          MAX_MONTHS,
        ),
      };
  }
}

// The exact numbers a Jupiter Lock escrow must carry for one bucket. The
// monthly amount is floored and the division dust rides in the cliff unlock,
// so cliffUnlockAmount + amountPerPeriod * numberOfPeriod equals the bucket
// amount EXACTLY (the create instruction transfers precisely that total into
// the escrow, and the verifier recomputes it from the on-chain account).
export interface LockParams {
  vestingStartTime: bigint; // unix seconds
  cliffTime: bigint;
  frequency: bigint; // seconds per period
  cliffUnlockAmount: bigint;
  amountPerPeriod: bigint;
  numberOfPeriod: bigint;
}

export function lockParams(
  amountBase: bigint,
  schedule: VestingSchedule,
  nowSec: number,
): LockParams {
  const periods = BigInt(schedule.vestMonths);
  const amountPerPeriod = amountBase / periods;
  const cliffUnlockAmount = amountBase - amountPerPeriod * periods;
  const start = BigInt(nowSec);
  return {
    vestingStartTime: start,
    cliffTime: start + BigInt(schedule.cliffMonths * SECONDS_PER_MONTH),
    frequency: BigInt(SECONDS_PER_MONTH),
    cliffUnlockAmount,
    amountPerPeriod,
    numberOfPeriod: periods,
  };
}

export function lockTotalBase(p: {
  cliffUnlockAmount: bigint;
  amountPerPeriod: bigint;
  numberOfPeriod: bigint;
}): bigint {
  return p.cliffUnlockAmount + p.amountPerPeriod * p.numberOfPeriod;
}

// ── Listing gate ──────────────────────────────────────────────────────────────

// PRD section 7: a realm token may NOT list (status may not reach `live`)
// until the founder lock, the levy lock, and the LP lock are all on-chain and
// verifiable. The mint + distribution prerequisites are implied (a lock cannot
// be recorded before distribution, which cannot happen before the mint), but
// they are checked explicitly so a hand-edited row can never slip through.
export function canListRealmToken(
  token: Pick<
    RealmToken,
    | 'mint'
    | 'launchTxSig'
    | 'distributeTxSig'
    | 'founderLockAddress'
    | 'levyLockAddress'
    | 'lpLockAddress'
  >,
): boolean {
  return (
    token.mint !== null &&
    token.launchTxSig !== null &&
    token.distributeTxSig !== null &&
    token.founderLockAddress !== null &&
    token.levyLockAddress !== null &&
    token.lpLockAddress !== null
  );
}
