// ---------------------------------------------------------------------------
// $WOC holder travel mounts — shared, host-agnostic data.
//
// Holding a share of the $WOC supply unlocks a rideable travel mount. Unlike the
// purely-cosmetic holder-tier nameplate flair (src/ui/holder_tier.ts), a mount is
// a REAL gameplay perk: a classic ground-mount move-speed boost. Eligibility is
// dynamic — it tracks the wallet's live balance, so selling below a rung removes
// access (the server dismounts you on the next balance refresh).
//
// This module lives in sim/ so it carries no DOM/render/net imports and runs
// unchanged on the server, offline, and headless. The authoritative Sim reads
// `speedMult`/`tier` for the gameplay rule; the server maps a balance to a tier
// via mountTierForBalance(); the client HUD reads names/thresholds for the mount
// window. The procedural mount VISUAL recipe lives in the renderer
// (src/render/characters/mount.ts), keyed by these ids — gameplay data here,
// presentation there.
//
// Supply basis: thresholds are absolute whole-$WOC amounts, fixed against the
// 1,000,000,000 max supply (the same basis src/ui/holder_tier.ts uses). The sim
// cannot import that UI constant (sim/ depends on nothing else in src/), so the
// amounts are written out and the supply share is documented per rung.
// ---------------------------------------------------------------------------

/** $WOC max supply the percentage rungs are taken against (1,000,000,000). */
export const MOUNT_SUPPLY_BASIS = 1_000_000_000;

/** Classic ground-mount speed multipliers (multiply base RUN_SPEED). The two
 *  canonical vanilla ground speeds — +60% (normal) and +100% (epic). The 0.1%
 *  entry rung rides the normal mount; every rung from 1% up rides the epic. We do
 *  NOT invent an 11-step speed gradient (that would break the no-pay-to-win-math
 *  spirit and the vanilla-formula invariant); higher rungs escalate in prestige
 *  and visual grandeur only. */
export const MOUNT_SPEED_NORMAL = 1.6;
export const MOUNT_SPEED_EPIC = 2.0;

export interface MountDef {
  /** Stable machine id (wire value, render-recipe key, dev-command target). */
  id: string;
  /** 1-based rung: 1 = the 0.1% mount … 11 = the 10% mount. */
  tier: number;
  /** Display name (proper noun; plain English, mirroring holder_tier.ts names). */
  name: string;
  /** Short hype line shown in the mount window (plain English, like holder flavor). */
  flavor: string;
  /** Minimum whole-$WOC balance to unlock this mount. */
  threshold: number;
  /** This rung's share of MOUNT_SUPPLY_BASIS, as a fraction in [0, 1]. */
  supplyShare: number;
  /** Base-run-speed multiplier applied while mounted and out of combat. */
  speedMult: number;
  /** Accent colour (hex) for the mount window swatch + a hint to the renderer. */
  tint: number;
}

// The eleven rungs the operator chose: the 0.1% line, then every whole percent
// from 1% to 10%. Ordered low → high; index in MOUNT_LIST is tier-1.
export const MOUNT_LIST: readonly MountDef[] = [
  { id: 'ashmane', tier: 1, name: 'Ashmane Courser', flavor: 'The deep parts when you ride — 0.1% of supply.', threshold: 1_000_000, supplyShare: 0.001, speedMult: MOUNT_SPEED_NORMAL, tint: 0x8a7766 },
  { id: 'emberhoof', tier: 2, name: 'Emberhoof Charger', flavor: 'Hooves that strike sparks — 1% of supply.', threshold: 10_000_000, supplyShare: 0.01, speedMult: MOUNT_SPEED_EPIC, tint: 0xc2542a },
  { id: 'bronzeflank', tier: 3, name: 'Bronzeflank Destrier', flavor: 'Barded in beaten bronze — 2% of supply.', threshold: 20_000_000, supplyShare: 0.02, speedMult: MOUNT_SPEED_EPIC, tint: 0xb87333 },
  { id: 'silvermane', tier: 4, name: 'Silvermane Stallion', flavor: 'A mane like cold moonlight — 3% of supply.', threshold: 30_000_000, supplyShare: 0.03, speedMult: MOUNT_SPEED_EPIC, tint: 0xcbd6e2 },
  { id: 'stormhoof', tier: 5, name: 'Stormhoof Charger', flavor: 'It runs ahead of the thunder — 4% of supply.', threshold: 40_000_000, supplyShare: 0.04, speedMult: MOUNT_SPEED_EPIC, tint: 0x5b7fa6 },
  { id: 'goldcrest', tier: 6, name: 'Goldcrest Warhorse', flavor: 'Gilded to the fetlock — 5% of supply.', threshold: 50_000_000, supplyShare: 0.05, speedMult: MOUNT_SPEED_EPIC, tint: 0xffd24a },
  { id: 'verdant', tier: 7, name: 'Verdant Wildhart', flavor: 'A living thing of the deep wood — 6% of supply.', threshold: 60_000_000, supplyShare: 0.06, speedMult: MOUNT_SPEED_EPIC, tint: 0x57e0b9 },
  { id: 'voidstrider', tier: 8, name: 'Voidstrider', flavor: 'Its hoofprints smoke and fade — 7% of supply.', threshold: 70_000_000, supplyShare: 0.07, speedMult: MOUNT_SPEED_EPIC, tint: 0x9b6cff },
  { id: 'celestial', tier: 9, name: 'Celestial Charger', flavor: 'Star-shod, saddled in light — 8% of supply.', threshold: 80_000_000, supplyShare: 0.08, speedMult: MOUNT_SPEED_EPIC, tint: 0xff5c8a },
  { id: 'worldbearer', tier: 10, name: "Worldbearer's Behemoth", flavor: 'It carries a piece of the world — 9% of supply.', threshold: 90_000_000, supplyShare: 0.09, speedMult: MOUNT_SPEED_EPIC, tint: 0xff8a4c },
  { id: 'sovereign', tier: 11, name: 'Sovereign Dreadsteed', flavor: 'The realm bends the knee — 10% of supply.', threshold: 100_000_000, supplyShare: 0.1, speedMult: MOUNT_SPEED_EPIC, tint: 0xffe27a },
] as const;

/** Id → def, for O(1) lookups by the sim (speed) and wire decode (render). */
export const MOUNTS: Readonly<Record<string, MountDef>> = Object.fromEntries(
  MOUNT_LIST.map((m) => [m.id, m]),
);

/** The highest mount tier a balance qualifies for: 0 = none (no wallet, or below
 *  the 0.1% line), 1-11 otherwise. A null balance (no connected wallet) is 0. */
export function mountTierForBalance(balance: number | null): number {
  if (balance === null || !Number.isFinite(balance) || balance < MOUNT_LIST[0].threshold) return 0;
  let tier = 0;
  for (const m of MOUNT_LIST) {
    if (balance >= m.threshold) tier = m.tier;
    else break;
  }
  return tier;
}

/** The def at a 1-based tier (1-11), or undefined for 0 / out-of-range. */
export function mountForTier(tier: number): MountDef | undefined {
  return tier >= 1 && tier <= MOUNT_LIST.length ? MOUNT_LIST[tier - 1] : undefined;
}

/** The def for a mount id, or undefined if the id is unknown. */
export function mountDef(id: string | null | undefined): MountDef | undefined {
  return id ? MOUNTS[id] : undefined;
}

/** Whether an eligibility tier (0-11) is allowed to ride the mount with id. The
 *  authoritative gate: you may summon any mount whose rung is at or below the
 *  highest you currently qualify for. */
export function mountUnlockedAtTier(id: string, eligibleTier: number): boolean {
  const def = MOUNTS[id];
  return def !== undefined && eligibleTier >= def.tier;
}
