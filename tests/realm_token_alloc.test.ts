// Launchpad phase 3 allocation + vesting math (server/realm_token_alloc.ts):
// the env-resolved allocation always sums to exactly 10000 bps with every
// override capped, the supply split is exact to the base unit with the
// remainder absorbed by the public bucket, and the Jupiter Lock schedules
// account for every locked unit with the levy lock the strictest on the cap
// table (PRD sections 7 and 8).

import { describe, expect, it } from 'vitest';
import {
  FOUNDER_BPS_CAP,
  LEVY_BPS_CAP,
  LIQUIDITY_BPS_CAP,
  MONTH_SECONDS,
  PUBLIC_BPS_FLOOR,
  REALM_TOKEN_DECIMALS,
  realmTokenSupplyBase,
  resolveAllocationBps,
  scheduleTotal,
  splitSupplyBase,
  TREASURY_BPS_CAP,
  vestingDurationSeconds,
  vestingScheduleFor,
} from '../server/realm_token_alloc';

const sumBps = (a: ReturnType<typeof resolveAllocationBps>): number =>
  a.publicBps + a.liquidityBps + a.founderBps + a.levyBps + a.treasuryBps;

describe('resolveAllocationBps', () => {
  it('defaults to the PRD table: 60/10/12/8/10', () => {
    const a = resolveAllocationBps({});
    expect(a).toEqual({
      publicBps: 6000,
      liquidityBps: 1000,
      founderBps: 1200,
      levyBps: 800,
      treasuryBps: 1000,
    });
    expect(sumBps(a)).toBe(10_000);
  });

  it('honors in-cap env overrides and keeps the exact 10000 sum', () => {
    const a = resolveAllocationBps({
      REALM_TOKEN_ALLOC_FOUNDER_BPS: '1500',
      REALM_TOKEN_ALLOC_LEVY_BPS: '1000',
      REALM_TOKEN_ALLOC_TREASURY_BPS: '1500',
      REALM_TOKEN_ALLOC_LIQUIDITY_BPS: '2000',
    });
    expect(a.founderBps).toBe(1500);
    expect(a.levyBps).toBe(1000);
    expect(a.treasuryBps).toBe(1500);
    expect(a.liquidityBps).toBe(2000);
    expect(a.publicBps).toBe(4000);
    expect(sumBps(a)).toBe(10_000);
  });

  it('rejects an over-cap override back to the default, never clamping', () => {
    // A founder allocation over the 15 percent hard cap is the exact rug
    // signal the caps exist to prevent; it must not silently clamp to 1500.
    const a = resolveAllocationBps({
      REALM_TOKEN_ALLOC_FOUNDER_BPS: String(FOUNDER_BPS_CAP + 1),
      REALM_TOKEN_ALLOC_LEVY_BPS: String(LEVY_BPS_CAP + 500),
      REALM_TOKEN_ALLOC_TREASURY_BPS: String(TREASURY_BPS_CAP + 1),
      REALM_TOKEN_ALLOC_LIQUIDITY_BPS: String(LIQUIDITY_BPS_CAP + 1),
    });
    expect(a.founderBps).toBe(1200);
    expect(a.levyBps).toBe(800);
    expect(a.treasuryBps).toBe(1000);
    expect(a.liquidityBps).toBe(1000);
  });

  it('rejects garbage and negative overrides back to the default', () => {
    const a = resolveAllocationBps({
      REALM_TOKEN_ALLOC_FOUNDER_BPS: 'fifteen',
      REALM_TOKEN_ALLOC_LEVY_BPS: '-1',
      REALM_TOKEN_ALLOC_TREASURY_BPS: '10.5',
    });
    expect(a.founderBps).toBe(1200);
    expect(a.levyBps).toBe(800);
    expect(a.treasuryBps).toBe(1000);
  });

  it('guarantees the public floor at every cap simultaneously', () => {
    // With every capped bucket at its hard cap the public bucket sits exactly
    // at the floor: the "bulk sells on the open curve" property is structural.
    expect(10_000 - FOUNDER_BPS_CAP - LEVY_BPS_CAP - TREASURY_BPS_CAP - LIQUIDITY_BPS_CAP).toBe(
      PUBLIC_BPS_FLOOR,
    );
  });
});

describe('realmTokenSupplyBase', () => {
  it('defaults to one billion tokens at 9 decimals', () => {
    expect(realmTokenSupplyBase({})).toBe(1_000_000_000n * 10n ** 9n);
    expect(REALM_TOKEN_DECIMALS).toBe(9);
  });

  it('honors a bounded whole-token override and rejects out-of-range values', () => {
    expect(realmTokenSupplyBase({ REALM_TOKEN_SUPPLY: '1000000' })).toBe(1_000_000n * 10n ** 9n);
    expect(realmTokenSupplyBase({ REALM_TOKEN_SUPPLY: '999999' })).toBe(1_000_000_000n * 10n ** 9n);
    expect(realmTokenSupplyBase({ REALM_TOKEN_SUPPLY: '10000000001' })).toBe(
      1_000_000_000n * 10n ** 9n,
    );
    expect(realmTokenSupplyBase({ REALM_TOKEN_SUPPLY: 'lots' })).toBe(1_000_000_000n * 10n ** 9n);
  });

  it('keeps the maximum supply inside u64 (Token-2022 amounts)', () => {
    expect(realmTokenSupplyBase({ REALM_TOKEN_SUPPLY: '10000000000' })).toBeLessThan(2n ** 64n);
  });
});

describe('splitSupplyBase', () => {
  const alloc = resolveAllocationBps({});

  it('splits the default supply exactly per the table', () => {
    const supply = 1_000_000_000n * 10n ** 9n;
    const s = splitSupplyBase(supply, alloc);
    expect(s.publicBase).toBe((supply * 6000n) / 10_000n);
    expect(s.liquidityBase).toBe((supply * 1000n) / 10_000n);
    expect(s.founderBase).toBe((supply * 1200n) / 10_000n);
    expect(s.levyBase).toBe((supply * 800n) / 10_000n);
    expect(s.treasuryBase).toBe((supply * 1000n) / 10_000n);
  });

  it('sums to exactly the supply at adversarial values (remainder to public)', () => {
    // Primes and near-misses that do not divide by 10000: every dropped
    // fraction must land in the public bucket, never vanish.
    for (const supply of [10_007n, 999_999_999_999_983n, 3n * 10n ** 17n + 1n, 12_345_678_901n]) {
      const s = splitSupplyBase(supply, alloc);
      expect(s.publicBase + s.liquidityBase + s.founderBase + s.levyBase + s.treasuryBase).toBe(
        supply,
      );
      expect(s.publicBase).toBeGreaterThanOrEqual((supply * 6000n) / 10_000n);
    }
  });

  it('rejects a non-positive supply', () => {
    expect(() => splitSupplyBase(0n, alloc)).toThrow();
    expect(() => splitSupplyBase(-1n, alloc)).toThrow();
  });
});

describe('vestingScheduleFor', () => {
  it('pins the PRD terms: founder 12+36, levy 12+48, treasury 6+24', () => {
    const founder = vestingScheduleFor('founder', 120_000_000_000n);
    expect(founder.cliffMonths).toBe(12);
    expect(founder.linearMonths).toBe(36);
    expect(founder.numberOfPeriod).toBe(36n);
    const levy = vestingScheduleFor('levy', 80_000_000_000n);
    expect(levy.cliffMonths).toBe(12);
    expect(levy.linearMonths).toBe(48);
    const treasury = vestingScheduleFor('treasury', 100_000_000_000n);
    expect(treasury.cliffMonths).toBe(6);
    expect(treasury.linearMonths).toBe(24);
  });

  it('accounts for every locked base unit (remainder into the cliff unlock)', () => {
    for (const amount of [1n, 35n, 36n, 37n, 10n ** 17n + 13n, 123_456_789_012_345n]) {
      for (const bucket of ['founder', 'levy', 'treasury'] as const) {
        const s = vestingScheduleFor(bucket, amount);
        expect(scheduleTotal(s)).toBe(amount);
        expect(s.cliffUnlockAmount).toBeLessThan(s.numberOfPeriod);
      }
    }
  });

  it('keeps the levy lock the strictest schedule on the cap table', () => {
    const amount = 10n ** 15n;
    const levy = vestingDurationSeconds(vestingScheduleFor('levy', amount));
    const founder = vestingDurationSeconds(vestingScheduleFor('founder', amount));
    const treasury = vestingDurationSeconds(vestingScheduleFor('treasury', amount));
    expect(levy).toBeGreaterThan(founder);
    expect(levy).toBeGreaterThan(treasury);
    // And the founder commitment is the advertised 4 years total.
    expect(founder).toBe(48n * MONTH_SECONDS);
    expect(levy).toBe(60n * MONTH_SECONDS);
  });

  it('rejects a non-positive amount', () => {
    expect(() => vestingScheduleFor('founder', 0n)).toThrow();
  });
});
