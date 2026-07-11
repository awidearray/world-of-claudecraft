// Realm token allocation + vesting math (launchpad phase 3, PRD section 7).
// PURE: no I/O, no RPC, no SQL. The mint factory (realm_token_mint.ts) pins an
// allocation snapshot from these resolvers at prepare time and later verifies
// the on-chain distribution and Jupiter Lock escrows against the exact numbers,
// so every function here is exact bigint math with unit-tested boundaries.
//
// The economics in one line (PRD "Default allocation"): the bulk of supply
// (public bucket, default 60 percent) sells through the open bonding curve, the
// liquidity bucket pairs into the LP at graduation (permanently locked), and
// every other bucket (founder / Levy Street Fund / realm treasury) is locked in
// an IMMUTABLE Jupiter Lock vesting escrow before the token may list. The
// founder bucket is hard-capped at 15 percent, the levy bucket at 10, the
// treasury at 15; the caps are structural (an env override outside its cap
// falls back to the default), so no configuration can produce an insider-heavy
// cap table.

export const REALM_TOKEN_DECIMALS = 9;

// Allocation in basis points; always sums to exactly 10000 (the public bucket
// is the remainder by construction).
export interface AllocationBps {
  publicBps: number;
  liquidityBps: number;
  founderBps: number;
  levyBps: number;
  treasuryBps: number;
}

export const FOUNDER_BPS_CAP = 1500;
export const LEVY_BPS_CAP = 1000;
export const TREASURY_BPS_CAP = 1500;
export const LIQUIDITY_BPS_CAP = 2000;
// The public bucket floor is guaranteed by construction: with every capped
// bucket at its cap the public share is 10000 - (1500 + 1000 + 1500 + 2000) =
// 4000. Kept as an exported invariant so a future cap edit that would break
// "the bulk sells on the open curve" fails a test instead of shipping.
export const PUBLIC_BPS_FLOOR = 4000;

const DEFAULT_BPS = {
  liquidity: 1000,
  founder: 1200,
  levy: 800,
  treasury: 1000,
} as const;

function bpsEnv(raw: string | undefined, def: number, cap: number): number {
  if (raw === undefined || raw.trim() === '') return def;
  // Strict decimal integer only ("10.5" is a config mistake, not 10 bps).
  // Out-of-range (including anything over the hard cap) falls back to the
  // default rather than clamping: a silently clamped founder allocation would
  // misrepresent what the operator asked for.
  if (!/^[0-9]{1,5}$/.test(raw.trim())) return def;
  const n = Number.parseInt(raw, 10);
  return n <= cap ? n : def;
}

// Resolve the allocation snapshot from the environment (env-tunable within the
// hard caps, PRD section 7). The public bucket absorbs the remainder so the
// total is exactly 10000 bps.
export function resolveAllocationBps(
  env: Record<string, string | undefined> = process.env,
): AllocationBps {
  const liquidityBps = bpsEnv(
    env.REALM_TOKEN_ALLOC_LIQUIDITY_BPS,
    DEFAULT_BPS.liquidity,
    LIQUIDITY_BPS_CAP,
  );
  const founderBps = bpsEnv(
    env.REALM_TOKEN_ALLOC_FOUNDER_BPS,
    DEFAULT_BPS.founder,
    FOUNDER_BPS_CAP,
  );
  const levyBps = bpsEnv(env.REALM_TOKEN_ALLOC_LEVY_BPS, DEFAULT_BPS.levy, LEVY_BPS_CAP);
  const treasuryBps = bpsEnv(
    env.REALM_TOKEN_ALLOC_TREASURY_BPS,
    DEFAULT_BPS.treasury,
    TREASURY_BPS_CAP,
  );
  const publicBps = 10_000 - liquidityBps - founderBps - levyBps - treasuryBps;
  if (publicBps < PUBLIC_BPS_FLOOR) {
    // Unreachable while the caps above hold (see PUBLIC_BPS_FLOOR); if a cap
    // edit ever makes it reachable this must fail loudly, not launch a token
    // with a minority public float.
    throw new Error(`realm token allocation leaves public bucket at ${publicBps} bps`);
  }
  return { publicBps, liquidityBps, founderBps, levyBps, treasuryBps };
}

// Fixed total supply in base units. Authored in whole tokens via env (default
// one billion), expanded by the fixed 9 decimals. Bounded so the base-unit
// total stays far inside u64 (Token-2022 amounts are u64: max ~1.8e19).
export const REALM_TOKEN_SUPPLY_MIN = 1_000_000;
export const REALM_TOKEN_SUPPLY_MAX = 10_000_000_000;

export function realmTokenSupplyBase(
  env: Record<string, string | undefined> = process.env,
): bigint {
  const raw = env.REALM_TOKEN_SUPPLY;
  let whole = 1_000_000_000;
  if (raw !== undefined && /^[0-9]{1,12}$/.test(raw.trim())) {
    const n = Number.parseInt(raw, 10);
    if (n >= REALM_TOKEN_SUPPLY_MIN && n <= REALM_TOKEN_SUPPLY_MAX) whole = n;
  }
  return BigInt(whole) * 10n ** BigInt(REALM_TOKEN_DECIMALS);
}

// The supply split in base units. Every non-public bucket floors its share;
// the public bucket takes the remainder, so the five buckets sum to exactly
// the supply (verified by test at adversarial values).
export interface SupplySplit {
  publicBase: bigint;
  liquidityBase: bigint;
  founderBase: bigint;
  levyBase: bigint;
  treasuryBase: bigint;
}

export function splitSupplyBase(supplyBase: bigint, alloc: AllocationBps): SupplySplit {
  if (supplyBase <= 0n) throw new Error('supplyBase must be positive');
  const share = (bps: number): bigint => (supplyBase * BigInt(bps)) / 10_000n;
  const liquidityBase = share(alloc.liquidityBps);
  const founderBase = share(alloc.founderBps);
  const levyBase = share(alloc.levyBps);
  const treasuryBase = share(alloc.treasuryBps);
  const publicBase = supplyBase - liquidityBase - founderBase - levyBase - treasuryBase;
  return { publicBase, liquidityBase, founderBase, levyBase, treasuryBase };
}

// ── Vesting schedules (Jupiter Lock terms) ───────────────────────────────────

// The three locked buckets, in Jupiter Lock's own vocabulary: nothing unlocks
// before cliffTime; at the cliff, cliffUnlockAmount releases; then
// amountPerPeriod releases every `frequency` seconds, numberOfPeriod times.
// Deposit total == cliffUnlockAmount + amountPerPeriod * numberOfPeriod, exact.
export interface VestingSchedule {
  cliffMonths: number;
  linearMonths: number;
  frequency: bigint; // seconds per unlock period
  cliffUnlockAmount: bigint;
  amountPerPeriod: bigint;
  numberOfPeriod: bigint;
}

export type LockedBucket = 'founder' | 'levy' | 'treasury';

// Average Gregorian month in seconds (365.2425 days * 86400 / 12). One shared
// constant so "12-month cliff" means the same on every lock.
export const MONTH_SECONDS = 2_629_746n;

// PRD section 7 terms: founder 12-month cliff + 36-month linear (hard commit),
// the Levy Street Fund on the STRICTEST schedule on the cap table (12 + 48),
// realm treasury 6 + 24 (vested, never instantly liquid). The linear remainder
// that integer division drops is folded into the cliff unlock so the deposit
// total is exact.
const LOCK_TERMS: Record<LockedBucket, { cliffMonths: number; linearMonths: number }> = {
  founder: { cliffMonths: 12, linearMonths: 36 },
  levy: { cliffMonths: 12, linearMonths: 48 },
  treasury: { cliffMonths: 6, linearMonths: 24 },
};

export function vestingScheduleFor(bucket: LockedBucket, amountBase: bigint): VestingSchedule {
  if (amountBase <= 0n) throw new Error('vesting amount must be positive');
  const terms = LOCK_TERMS[bucket];
  const periods = BigInt(terms.linearMonths);
  const amountPerPeriod = amountBase / periods;
  const cliffUnlockAmount = amountBase - amountPerPeriod * periods;
  return {
    cliffMonths: terms.cliffMonths,
    linearMonths: terms.linearMonths,
    frequency: MONTH_SECONDS,
    cliffUnlockAmount,
    amountPerPeriod,
    numberOfPeriod: periods,
  };
}

export function scheduleTotal(s: VestingSchedule): bigint {
  return s.cliffUnlockAmount + s.amountPerPeriod * s.numberOfPeriod;
}

// Full vesting duration in seconds from vesting start: cliff + every linear
// period. Used to assert the levy lock is the strictest schedule on the cap
// table (PRD section 8) and to bound-check submitted escrows.
export function vestingDurationSeconds(s: VestingSchedule): bigint {
  return BigInt(s.cliffMonths) * MONTH_SECONDS + s.frequency * s.numberOfPeriod;
}
