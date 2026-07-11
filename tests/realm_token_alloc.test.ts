// Launchpad phase 3 allocation + lock policy (server/realm_token_alloc.ts):
// the exact fixed-supply split (sums to 100 percent of supply, dust to the
// public curve), the env clamps against the PRD hard caps, the vesting lock
// math (cliff + linear periods reconstructing the bucket amount exactly), the
// levy-is-strictest pin, and the listing gate matrix.

import { afterEach, describe, expect, it } from 'vitest';
import {
  allocationBps,
  bucketSchedule,
  canListRealmToken,
  computeAllocation,
  DEFAULT_ALLOCATION_BPS,
  FOUNDER_BPS_CAP,
  FOUNDER_SCHEDULE,
  LEVY_BPS_CAP,
  LEVY_SCHEDULE,
  LOCK_BUCKETS,
  lockParams,
  lockTotalBase,
  SECONDS_PER_MONTH,
  TREASURY_SCHEDULE,
  tokenSupplyBase,
  U64_MAX,
} from '../server/realm_token_alloc';

const ENV_KEYS = [
  'REALM_TOKEN_LIQUIDITY_BPS',
  'REALM_TOKEN_FOUNDER_BPS',
  'REALM_TOKEN_LEVY_BPS',
  'REALM_TOKEN_TREASURY_BPS',
  'REALM_TOKEN_SUPPLY_BASE',
  'REALM_TOKEN_FOUNDER_CLIFF_MONTHS',
  'REALM_TOKEN_FOUNDER_VEST_MONTHS',
  'REALM_TOKEN_LEVY_CLIFF_MONTHS',
  'REALM_TOKEN_LEVY_VEST_MONTHS',
  'REALM_TOKEN_TREASURY_CLIFF_MONTHS',
  'REALM_TOKEN_TREASURY_VEST_MONTHS',
];

afterEach(() => {
  for (const k of ENV_KEYS) delete process.env[k];
});

describe('allocationBps', () => {
  it('defaults to the PRD table and sums to exactly 10000', () => {
    const bps = allocationBps();
    expect(bps).toEqual(DEFAULT_ALLOCATION_BPS);
    expect(bps.publicCurve + bps.liquidity + bps.founder + bps.levy + bps.treasury).toBe(10_000);
  });

  it('derives the public share from tuned buckets, still summing to 10000', () => {
    process.env.REALM_TOKEN_FOUNDER_BPS = '1500';
    process.env.REALM_TOKEN_LEVY_BPS = '1000';
    const bps = allocationBps();
    expect(bps.founder).toBe(1500);
    expect(bps.levy).toBe(1000);
    expect(bps.publicCurve).toBe(10_000 - 1500 - 1000 - bps.liquidity - bps.treasury);
    expect(bps.publicCurve + bps.liquidity + bps.founder + bps.levy + bps.treasury).toBe(10_000);
  });

  it('rejects an over-cap bucket back to its default (founder 15, levy 10)', () => {
    process.env.REALM_TOKEN_FOUNDER_BPS = String(FOUNDER_BPS_CAP + 1);
    process.env.REALM_TOKEN_LEVY_BPS = String(LEVY_BPS_CAP + 1);
    const bps = allocationBps();
    expect(bps.founder).toBe(DEFAULT_ALLOCATION_BPS.founder);
    expect(bps.levy).toBe(DEFAULT_ALLOCATION_BPS.levy);
  });

  it('falls back wholesale when the derived public share starves the curve', () => {
    // All buckets at their caps: 2000 + 1500 + 1000 + 1500 leaves 4000 < 5000.
    process.env.REALM_TOKEN_LIQUIDITY_BPS = '2000';
    process.env.REALM_TOKEN_FOUNDER_BPS = '1500';
    process.env.REALM_TOKEN_LEVY_BPS = '1000';
    process.env.REALM_TOKEN_TREASURY_BPS = '1500';
    expect(allocationBps()).toEqual(DEFAULT_ALLOCATION_BPS);
  });
});

describe('tokenSupplyBase', () => {
  it('defaults to one billion tokens at 9 decimals', () => {
    expect(tokenSupplyBase()).toBe(1_000_000_000n * 10n ** 9n);
  });

  it('accepts a tuned supply within u64 and rejects the rest', () => {
    process.env.REALM_TOKEN_SUPPLY_BASE = '1000000';
    expect(tokenSupplyBase()).toBe(1_000_000n);
    process.env.REALM_TOKEN_SUPPLY_BASE = (U64_MAX + 1n).toString();
    expect(tokenSupplyBase()).toBe(1_000_000_000n * 10n ** 9n);
    process.env.REALM_TOKEN_SUPPLY_BASE = '0';
    expect(tokenSupplyBase()).toBe(1_000_000_000n * 10n ** 9n);
    process.env.REALM_TOKEN_SUPPLY_BASE = 'abc';
    expect(tokenSupplyBase()).toBe(1_000_000_000n * 10n ** 9n);
  });
});

describe('computeAllocation', () => {
  it('splits the default supply exactly per the default bps', () => {
    const supply = 1_000_000_000n * 10n ** 9n;
    const a = computeAllocation(supply, DEFAULT_ALLOCATION_BPS);
    expect(a.publicCurveBase).toBe((supply * 6000n) / 10_000n);
    expect(a.liquidityBase).toBe((supply * 1000n) / 10_000n);
    expect(a.founderBase).toBe((supply * 1200n) / 10_000n);
    expect(a.levyBase).toBe((supply * 800n) / 10_000n);
    expect(a.treasuryBase).toBe((supply * 1000n) / 10_000n);
  });

  it('sums to EXACTLY the supply, dust riding in the public bucket', () => {
    // 10007 is prime-ish enough that every bucket floors with a remainder.
    for (const supply of [10_007n, 999_999_999_999_999_999n, 1n, 7n]) {
      const a = computeAllocation(supply, DEFAULT_ALLOCATION_BPS);
      const sum = a.publicCurveBase + a.liquidityBase + a.founderBase + a.levyBase + a.treasuryBase;
      expect(sum).toBe(supply);
      // Dust lands in publicCurve: it is >= its exact floor share.
      expect(a.publicCurveBase).toBeGreaterThanOrEqual((supply * 6000n) / 10_000n);
    }
  });
});

describe('vesting schedules + lock math', () => {
  it('pins the PRD minimums: founder 12+36, levy 12+48 (strictest), treasury 12+36', () => {
    expect(FOUNDER_SCHEDULE).toEqual({ cliffMonths: 12, vestMonths: 36 });
    expect(LEVY_SCHEDULE).toEqual({ cliffMonths: 12, vestMonths: 48 });
    expect(TREASURY_SCHEDULE).toEqual({ cliffMonths: 12, vestMonths: 36 });
    // The levy schedule is the strictest on the cap table: no other bucket may
    // vest over a longer total than the platform's own bag.
    for (const bucket of LOCK_BUCKETS) {
      const s = bucketSchedule(bucket);
      expect(LEVY_SCHEDULE.cliffMonths + LEVY_SCHEDULE.vestMonths).toBeGreaterThanOrEqual(
        bucket === 'levy' ? s.cliffMonths + s.vestMonths : FOUNDER_SCHEDULE.cliffMonths,
      );
    }
    const levy = bucketSchedule('levy');
    const founder = bucketSchedule('founder');
    expect(levy.cliffMonths + levy.vestMonths).toBeGreaterThanOrEqual(
      founder.cliffMonths + founder.vestMonths,
    );
  });

  it('env can only LENGTHEN a schedule, never shorten it', () => {
    process.env.REALM_TOKEN_FOUNDER_CLIFF_MONTHS = '6'; // under the 12 minimum
    process.env.REALM_TOKEN_FOUNDER_VEST_MONTHS = '48'; // over is fine
    const s = bucketSchedule('founder');
    expect(s.cliffMonths).toBe(12);
    expect(s.vestMonths).toBe(48);
  });

  it('reconstructs the bucket amount exactly: cliff dust + periods', () => {
    const now = 1_752_000_000;
    for (const amount of [120_000_000_000n, 100_000_000_007n, 35n, 10n ** 17n]) {
      const p = lockParams(amount, FOUNDER_SCHEDULE, now);
      expect(lockTotalBase(p)).toBe(amount);
      expect(p.numberOfPeriod).toBe(36n);
      expect(p.frequency).toBe(BigInt(SECONDS_PER_MONTH));
      expect(p.vestingStartTime).toBe(BigInt(now));
      expect(p.cliffTime).toBe(BigInt(now + 12 * SECONDS_PER_MONTH));
      // The dust is strictly smaller than one period.
      expect(p.cliffUnlockAmount).toBeLessThan(p.amountPerPeriod + BigInt(36));
    }
  });
});

describe('canListRealmToken (the listing gate)', () => {
  const full = {
    mint: 'Mint111',
    launchTxSig: 'sig1',
    distributeTxSig: 'sig2',
    founderLockAddress: 'lockF',
    levyLockAddress: 'lockL',
    lpLockAddress: 'lockLP',
  };

  it('opens only when mint, distribution, and all three PRD locks are present', () => {
    expect(canListRealmToken(full)).toBe(true);
  });

  it('stays closed while ANY prerequisite is missing', () => {
    for (const key of Object.keys(full) as Array<keyof typeof full>) {
      expect(canListRealmToken({ ...full, [key]: null })).toBe(false);
    }
  });
});
