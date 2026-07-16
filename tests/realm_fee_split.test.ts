// Launchpad phase 5 fee split math (server/realm_fee_split.ts): the exact
// four-leg division (operator / treasury / affiliate / burn), the affiliate
// paid out of the operator side, the env clamp, and the sum-to-total dust
// invariant.

import { afterEach, describe, expect, it } from 'vitest';
import {
  DEFAULT_REALM_FEE_SPLIT_BPS,
  realmFeeSplitBps,
  splitRealmFees,
} from '../server/realm_fee_split';

const ENV = ['REALM_FEE_OPERATOR_BPS', 'REALM_FEE_TREASURY_BPS', 'REALM_FEE_BURN_BPS'];
afterEach(() => {
  for (const k of ENV) delete process.env[k];
});

describe('realmFeeSplitBps', () => {
  it('defaults to 50/20/30 summing to 10000', () => {
    const bps = realmFeeSplitBps();
    expect(bps).toEqual(DEFAULT_REALM_FEE_SPLIT_BPS);
    expect(bps.operator + bps.treasury + bps.burn).toBe(10_000);
  });

  it('accepts a consistent env split', () => {
    process.env.REALM_FEE_OPERATOR_BPS = '4000';
    process.env.REALM_FEE_TREASURY_BPS = '3000';
    process.env.REALM_FEE_BURN_BPS = '3000';
    expect(realmFeeSplitBps()).toEqual({ operator: 4000, treasury: 3000, burn: 3000 });
  });

  it('falls back wholesale when the legs do not sum to 10000', () => {
    process.env.REALM_FEE_OPERATOR_BPS = '4000';
    process.env.REALM_FEE_TREASURY_BPS = '3000';
    process.env.REALM_FEE_BURN_BPS = '4000'; // sums to 11000
    expect(realmFeeSplitBps()).toEqual(DEFAULT_REALM_FEE_SPLIT_BPS);
  });
});

describe('splitRealmFees', () => {
  it('divides the four legs with the affiliate out of the operator side', () => {
    const s = splitRealmFees(1_000_000n, DEFAULT_REALM_FEE_SPLIT_BPS, 1500);
    expect(s.treasuryBase).toBe(200_000n);
    expect(s.burnBase).toBe(300_000n);
    // operator side = 500000; affiliate = 15% of it = 75000; operator = 425000.
    expect(s.affiliateBase).toBe(75_000n);
    expect(s.operatorBase).toBe(425_000n);
  });

  it('pays no affiliate when there is none', () => {
    const s = splitRealmFees(1_000_000n, DEFAULT_REALM_FEE_SPLIT_BPS, 0);
    expect(s.affiliateBase).toBe(0n);
    expect(s.operatorBase).toBe(500_000n);
  });

  it('sums to EXACTLY the total for adversarial amounts (dust in operator)', () => {
    for (const total of [1n, 7n, 10_007n, 999_999_999_999_999_999n, 3n]) {
      for (const affBps of [0, 1500, 5000]) {
        const s = splitRealmFees(total, DEFAULT_REALM_FEE_SPLIT_BPS, affBps);
        expect(s.operatorBase + s.treasuryBase + s.affiliateBase + s.burnBase).toBe(total);
        expect(s.operatorBase).toBeGreaterThanOrEqual(0n);
      }
    }
  });
});
