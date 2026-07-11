// Pure term/accrual math for Claudium Staking: lock $WOC for a fixed term,
// earn Claudium (the soft currency) at a term-keyed APY. Spec:
// docs/prd/woc/claudium-staking.md. No I/O: the Phase 2 epoch runner feeds it
// chain snapshots plus the oracle rate and persists what it returns; nothing
// here reads env, clock, or network at import time.
//
// Unit discipline (matches the Claudium purchase rails):
//  - $WOC amounts are base-unit bigints (chain truth).
//  - Claudium amounts are whole-number bigints (Claudium is an integer soft
//    currency; the service stores integers).
//  - Rates use the service oracle's wocBaseUnitsPerClaudium, the SAME rate the
//    woc purchase rail quotes, so a position's value in Claudium is just
//    stakeBase / rate and staking can never disagree with the buy flow about
//    what $WOC is worth.
//  - Dust floors to zero and is never carried or emitted (the
//    splitEpochEmission convention from the LP staking vault).

export interface ClaudiumStakeTerm {
  index: number;
  /** Stable machine key ('d30' .. 'd360'); flavor naming is a UI concern. */
  key: string;
  days: number;
  /** The on-chain lock length passed to the vault at stake time. */
  lockSeconds: number;
  /** APY in basis points (10000 = 100%), fixed at position open. */
  apyBps: number;
}

const DAY_SECONDS = 24 * 60 * 60;
const DAYS_PER_YEAR = 365n;
const BPS_DENOMINATOR = 10_000n;

/**
 * Hard clamp on any APY value, defaults or env override (50% APY). A program
 * constant, never configuration, so no retune can fat-finger an economy-scale
 * emission. Pinned by tests/claudium_staking_math.test.ts.
 */
export const CLAUDIUM_STAKE_MAX_APY_BPS = 5_000;

// The six fixed terms of the product. Only these durations are stakeable:
// the vault program itself accepts any lock up to 366 days, the term gate is
// a server-side product rule enforced at quote time. APY rises with the term;
// there is no ve-decay (a position earns its opening APY for its whole life,
// including past maturity until unstaked).
export const CLAUDIUM_STAKE_TERMS: readonly ClaudiumStakeTerm[] = [
  { index: 0, key: 'd30', days: 30, lockSeconds: 30 * DAY_SECONDS, apyBps: 500 },
  { index: 1, key: 'd60', days: 60, lockSeconds: 60 * DAY_SECONDS, apyBps: 700 },
  { index: 2, key: 'd90', days: 90, lockSeconds: 90 * DAY_SECONDS, apyBps: 900 },
  { index: 3, key: 'd120', days: 120, lockSeconds: 120 * DAY_SECONDS, apyBps: 1100 },
  { index: 4, key: 'd180', days: 180, lockSeconds: 180 * DAY_SECONDS, apyBps: 1400 },
  { index: 5, key: 'd360', days: 360, lockSeconds: 360 * DAY_SECONDS, apyBps: 2000 },
];

/** The term for an exact day count, or null (45 is not a product). */
export function termForDays(days: number): ClaudiumStakeTerm | null {
  return CLAUDIUM_STAKE_TERMS.find((t) => t.days === days) ?? null;
}

/** The term for a stable key ('d90'), or null. */
export function termForKey(key: string): ClaudiumStakeTerm | null {
  return CLAUDIUM_STAKE_TERMS.find((t) => t.key === key) ?? null;
}

/** Unix seconds at which a position opened at `openedAtSeconds` matures. */
export function maturityUnixSeconds(openedAtSeconds: number, term: ClaudiumStakeTerm): number {
  return openedAtSeconds + term.lockSeconds;
}

/**
 * One position's accrual for one daily epoch, in whole Claudium:
 *
 *   floor( stakeBase * apyBps / (wocBaseUnitsPerClaudium * 10_000 * 365) )
 *
 * Equivalent to (position value in Claudium) * APY / 365, floored. Returns 0n
 * on any non-positive or missing input: an oracle outage (rate null) means
 * that epoch accrues nothing and is not made up, never a guessed price.
 */
export function dailyAccrualClaudium(
  stakeBase: bigint,
  apyBps: number,
  wocBaseUnitsPerClaudium: bigint | null,
): bigint {
  if (stakeBase <= 0n) return 0n;
  if (!Number.isInteger(apyBps) || apyBps <= 0) return 0n;
  if (wocBaseUnitsPerClaudium === null || wocBaseUnitsPerClaudium <= 0n) return 0n;
  return (stakeBase * BigInt(apyBps)) / (wocBaseUnitsPerClaudium * BPS_DENOMINATOR * DAYS_PER_YEAR);
}

export interface StakeAccrualShare {
  positionId: string;
  claudium: bigint;
}

/**
 * Clamp one epoch's accruals to the global daily emission cap
 * (WOC_CLAUDIUM_STAKE_DAILY_EMISSION_CAP). Under the cap the shares pass
 * through unchanged (minus zero shares). Over it, every share scales pro rata
 * and floors, so the sum never exceeds the cap and no position is favored.
 * A zero or negative cap emits nothing (the fail-closed default: accrual is
 * dark until ops sets a real cap).
 */
export function clampToEmissionBudget(
  shares: readonly StakeAccrualShare[],
  capClaudium: bigint,
): StakeAccrualShare[] {
  if (capClaudium <= 0n) return [];
  const positive = shares.filter((s) => s.claudium > 0n);
  const total = positive.reduce((sum, s) => sum + s.claudium, 0n);
  if (total <= capClaudium) return positive;
  return positive
    .map((s) => ({ positionId: s.positionId, claudium: (s.claudium * capClaudium) / total }))
    .filter((s) => s.claudium > 0n);
}

/**
 * Parse the WOC_CLAUDIUM_STAKE_APY_BPS override ('30:500,60:700,...'): a map
 * of term days to APY bps. Malformed entries and unknown day counts are
 * ignored (fail-closed to the defaults); values clamp to
 * [0, CLAUDIUM_STAKE_MAX_APY_BPS]. A 0 override turns a term's accrual off
 * without removing the product.
 */
export function parseStakeApyOverrides(raw: string | undefined): Map<number, number> {
  const overrides = new Map<number, number>();
  if (!raw) return overrides;
  for (const entry of raw.split(',')) {
    const match = /^\s*(\d+)\s*:\s*(\d+)\s*$/.exec(entry);
    if (!match) continue;
    const days = Number(match[1]);
    if (!termForDays(days)) continue;
    const bps = Math.min(Number(match[2]), CLAUDIUM_STAKE_MAX_APY_BPS);
    overrides.set(days, bps);
  }
  return overrides;
}

/**
 * The term table with env overrides applied. Retunes are prospective only:
 * a position keeps the apyBps it was opened with (the service stores it per
 * position); this table is what NEW quotes are priced from.
 */
export function stakeTermsWithOverrides(raw: string | undefined): ClaudiumStakeTerm[] {
  const overrides = parseStakeApyOverrides(raw);
  return CLAUDIUM_STAKE_TERMS.map((t) => {
    const bps = overrides.get(t.days);
    return bps === undefined ? { ...t } : { ...t, apyBps: bps };
  });
}
