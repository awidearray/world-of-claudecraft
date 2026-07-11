// Per-realm trading-fee revenue split (launchpad phase 5, PRD section 7.8).
// Pure math only: the claimed DBC partner fees for one realm divide across the
// four legs by basis points, exactly:
//
//   operator   : the realm owner's share, MINUS the affiliate cut (the
//                affiliate is paid out of the operator's side, never the
//                platform's, matching the buy-a-realm precedent)
//   affiliate  : getRealmAffiliate bps of the operator share (0 when the realm
//                has no affiliate)
//   treasury   : the platform's global treasury
//   burn       : the $WOC buy-and-burn (or LP-seed) leg the keeper routes to
//                the pluggable terminal
//
// The four legs sum to EXACTLY the input (division dust rides in the operator
// leg, the largest by default), because a keeper that leaks base units drifts
// from its ledger. Env-tunable within the 10000 bps identity; an inconsistent
// configuration falls back to the defaults wholesale.

function intEnv(key: string, def: number, min: number, max: number): number {
  const v = Number.parseInt(process.env[key] ?? '', 10);
  return Number.isFinite(v) && v >= min && v <= max ? v : def;
}

export interface RealmFeeSplitBps {
  operator: number;
  treasury: number;
  burn: number;
}

export const DEFAULT_REALM_FEE_SPLIT_BPS: RealmFeeSplitBps = {
  operator: 5000,
  treasury: 2000,
  burn: 3000,
};

// The env-tuned split. The three legs must sum to exactly 10000 bps; anything
// else is a misconfiguration and the defaults win wholesale (never a partial
// mix).
export function realmFeeSplitBps(): RealmFeeSplitBps {
  const operator = intEnv(
    'REALM_FEE_OPERATOR_BPS',
    DEFAULT_REALM_FEE_SPLIT_BPS.operator,
    0,
    10_000,
  );
  const treasury = intEnv(
    'REALM_FEE_TREASURY_BPS',
    DEFAULT_REALM_FEE_SPLIT_BPS.treasury,
    0,
    10_000,
  );
  const burn = intEnv('REALM_FEE_BURN_BPS', DEFAULT_REALM_FEE_SPLIT_BPS.burn, 0, 10_000);
  if (operator + treasury + burn !== 10_000) return { ...DEFAULT_REALM_FEE_SPLIT_BPS };
  return { operator, treasury, burn };
}

export interface RealmFeeSplit {
  totalBase: bigint;
  operatorBase: bigint;
  treasuryBase: bigint;
  affiliateBase: bigint;
  burnBase: bigint;
}

// Exact bigint split. treasury and burn take their floor shares; the affiliate
// takes affiliateBps of the REMAINING operator side; the operator absorbs all
// division dust. operator + treasury + affiliate + burn == total, always.
export function splitRealmFees(
  totalBase: bigint,
  bps: RealmFeeSplitBps,
  affiliateBps: number,
): RealmFeeSplit {
  const treasuryBase = (totalBase * BigInt(bps.treasury)) / 10_000n;
  const burnBase = (totalBase * BigInt(bps.burn)) / 10_000n;
  const operatorSide = totalBase - treasuryBase - burnBase;
  const affiliateBase = (operatorSide * BigInt(affiliateBps)) / 10_000n;
  return {
    totalBase,
    operatorBase: operatorSide - affiliateBase,
    treasuryBase,
    affiliateBase,
    burnBase,
  };
}
