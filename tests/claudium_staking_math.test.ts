import { describe, expect, it } from 'vitest';
import {
  CLAUDIUM_STAKE_MAX_APY_BPS,
  CLAUDIUM_STAKE_TERMS,
  clampToEmissionBudget,
  dailyAccrualClaudium,
  maturityUnixSeconds,
  parseStakeApyOverrides,
  stakeTermsWithOverrides,
  termForDays,
  termForKey,
} from '../server/claudium_staking_math';

const DAY = 24 * 60 * 60;

// The six-term product table is code-of-record (docs/prd/woc/claudium-staking.md
// section 5.1); pin it exactly so a retune is a deliberate, reviewed diff here.
describe('CLAUDIUM_STAKE_TERMS table', () => {
  it('pins the six terms, their APYs, and their lock lengths', () => {
    expect(
      CLAUDIUM_STAKE_TERMS.map((t) => ({ key: t.key, days: t.days, apyBps: t.apyBps })),
    ).toEqual([
      { key: 'd30', days: 30, apyBps: 500 },
      { key: 'd60', days: 60, apyBps: 700 },
      { key: 'd90', days: 90, apyBps: 900 },
      { key: 'd120', days: 120, apyBps: 1100 },
      { key: 'd180', days: 180, apyBps: 1400 },
      { key: 'd360', days: 360, apyBps: 2000 },
    ]);
    for (const t of CLAUDIUM_STAKE_TERMS) {
      expect(t.lockSeconds).toBe(t.days * DAY);
      expect(t.apyBps).toBeLessThanOrEqual(CLAUDIUM_STAKE_MAX_APY_BPS);
    }
    // Indices are dense and ordered so the UI ladder can trust them.
    expect(CLAUDIUM_STAKE_TERMS.map((t) => t.index)).toEqual([0, 1, 2, 3, 4, 5]);
  });

  it('longer terms always pay more (the ladder is monotone)', () => {
    for (let i = 1; i < CLAUDIUM_STAKE_TERMS.length; i++) {
      expect(CLAUDIUM_STAKE_TERMS[i].apyBps).toBeGreaterThan(CLAUDIUM_STAKE_TERMS[i - 1].apyBps);
    }
  });
});

describe('term lookup', () => {
  it('finds every product term by days and by key', () => {
    for (const t of CLAUDIUM_STAKE_TERMS) {
      expect(termForDays(t.days)).toEqual(t);
      expect(termForKey(t.key)).toEqual(t);
    }
  });

  it('rejects non-product durations and keys', () => {
    expect(termForDays(45)).toBeNull();
    expect(termForDays(0)).toBeNull();
    expect(termForDays(365)).toBeNull();
    expect(termForKey('d45')).toBeNull();
    expect(termForKey('')).toBeNull();
  });

  it('computes maturity as open time plus the lock', () => {
    const d90 = termForDays(90)!;
    expect(maturityUnixSeconds(1_700_000_000, d90)).toBe(1_700_000_000 + 90 * DAY);
  });
});

describe('dailyAccrualClaudium', () => {
  // The PRD 5.2 worked example: 1,000,000 $WOC (6 decimals) at 180d/1400bps,
  // oracle at 3,333,333 base units per Claudium ($WOC around $0.003).
  it('matches the PRD worked example', () => {
    expect(dailyAccrualClaudium(1_000_000_000_000n, 1400, 3_333_333n)).toBe(115n);
  });

  it('accrues zero on any missing or non-positive input (oracle down, empty stake)', () => {
    expect(dailyAccrualClaudium(0n, 1400, 3_333_333n)).toBe(0n);
    expect(dailyAccrualClaudium(-5n, 1400, 3_333_333n)).toBe(0n);
    expect(dailyAccrualClaudium(1_000_000n, 0, 3_333_333n)).toBe(0n);
    expect(dailyAccrualClaudium(1_000_000n, -100, 3_333_333n)).toBe(0n);
    expect(dailyAccrualClaudium(1_000_000n, 1400, null)).toBe(0n);
    expect(dailyAccrualClaudium(1_000_000n, 1400, 0n)).toBe(0n);
    expect(dailyAccrualClaudium(1_000_000n, 1.5, 3_333_333n)).toBe(0n);
  });

  it('floors dust to zero for small positions', () => {
    // 1 $WOC base unit at 5% APY can never mint a whole Claudium in a day.
    expect(dailyAccrualClaudium(1n, 500, 3_333_333n)).toBe(0n);
  });

  it('a year of daily accrual never exceeds APY on the position value', () => {
    for (const t of CLAUDIUM_STAKE_TERMS) {
      const stakeBase = 987_654_321_000n;
      const rate = 41_337n;
      const daily = dailyAccrualClaudium(stakeBase, t.apyBps, rate);
      const positionValueClaudium = stakeBase / rate;
      const yearCeiling = (positionValueClaudium * BigInt(t.apyBps)) / 10_000n;
      expect(daily * 365n).toBeLessThanOrEqual(yearCeiling);
      // And flooring loses less than one Claudium per day.
      expect((daily + 1n) * 365n).toBeGreaterThan(yearCeiling);
    }
  });
});

describe('clampToEmissionBudget', () => {
  const shares = (pairs: [string, bigint][]) =>
    pairs.map(([positionId, claudium]) => ({ positionId, claudium }));

  it('passes shares through unchanged when under the cap', () => {
    const input = shares([
      ['a', 30n],
      ['b', 20n],
    ]);
    expect(clampToEmissionBudget(input, 100n)).toEqual(input);
  });

  it('scales pro rata, floored, when the cap binds, and the sum stays within it', () => {
    const clamped = clampToEmissionBudget(
      shares([
        ['a', 60n],
        ['b', 40n],
      ]),
      50n,
    );
    expect(clamped).toEqual(
      shares([
        ['a', 30n],
        ['b', 20n],
      ]),
    );
    const total = clamped.reduce((s, x) => s + x.claudium, 0n);
    expect(total).toBeLessThanOrEqual(50n);
  });

  it('drops zero shares (pre-existing and flooring-created) and never favors a position', () => {
    const clamped = clampToEmissionBudget(
      shares([
        ['whale', 1_000_000n],
        ['dust', 1n],
        ['zero', 0n],
      ]),
      100n,
    );
    // dust's pro-rata slice floors to zero; the whale keeps at most the cap.
    expect(clamped.map((s) => s.positionId)).toEqual(['whale']);
    expect(clamped[0].claudium).toBeLessThanOrEqual(100n);
  });

  it('a zero or negative cap emits nothing (accrual dark until ops sets a cap)', () => {
    const input = shares([['a', 10n]]);
    expect(clampToEmissionBudget(input, 0n)).toEqual([]);
    expect(clampToEmissionBudget(input, -5n)).toEqual([]);
  });

  it('conserves: clamped total never exceeds the smaller of cap and input total', () => {
    const input = shares([
      ['a', 7n],
      ['b', 13n],
      ['c', 29n],
    ]);
    for (const cap of [1n, 10n, 48n, 49n, 1_000n]) {
      const total = clampToEmissionBudget(input, cap).reduce((s, x) => s + x.claudium, 0n);
      expect(total).toBeLessThanOrEqual(cap < 49n ? cap : 49n);
    }
  });
});

describe('APY env overrides', () => {
  it('parses well-formed entries for product terms only', () => {
    const o = parseStakeApyOverrides('30:1000, 60:0 ,45:900,junk,:5,120:1300');
    expect(o.get(30)).toBe(1000);
    expect(o.get(60)).toBe(0);
    expect(o.get(120)).toBe(1300);
    expect(o.has(45)).toBe(false);
    expect(o.size).toBe(3);
  });

  it('clamps overrides to the max APY (the fat-finger guard)', () => {
    expect(parseStakeApyOverrides('360:99999').get(360)).toBe(CLAUDIUM_STAKE_MAX_APY_BPS);
  });

  it('an unset or empty env leaves the defaults untouched', () => {
    expect(parseStakeApyOverrides(undefined).size).toBe(0);
    expect(parseStakeApyOverrides('').size).toBe(0);
    expect(stakeTermsWithOverrides(undefined)).toEqual([...CLAUDIUM_STAKE_TERMS]);
  });

  it('applies overrides per term without mutating the table of record', () => {
    const terms = stakeTermsWithOverrides('90:1234');
    expect(terms.find((t) => t.days === 90)!.apyBps).toBe(1234);
    expect(terms.find((t) => t.days === 30)!.apyBps).toBe(500);
    expect(CLAUDIUM_STAKE_TERMS.find((t) => t.days === 90)!.apyBps).toBe(900);
  });
});
