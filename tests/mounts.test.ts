import { describe, it, expect } from 'vitest';
import { Sim } from '../src/sim/sim';
import { terrainHeight } from '../src/sim/world';
import {
  mountTierForBalance, mountUnlockedAtTier, MOUNT_LIST, MOUNTS,
  MOUNT_SPEED_NORMAL, MOUNT_SPEED_EPIC,
} from '../src/sim/content/mounts';

// The mount summon cast is 1.5s = 30 ticks at 20 Hz; 40 ticks clears it.
const CAST_TICKS = 40;

// Build a level-capped warrior parked on open ground away from any camp so a
// wandering mob can't aggro mid-cast and cancel the summon.
function makeRider() {
  const sim = new Sim({ seed: 7, playerClass: 'warrior', autoEquip: true });
  const p = sim.player;
  p.pos.x = 40; p.pos.z = 40;
  p.pos.y = terrainHeight(p.pos.x, p.pos.z, sim.cfg.seed);
  p.prevPos = { ...p.pos };
  return { sim, p };
}

function summonAndComplete(sim: Sim, id: string): void {
  expect(sim.summonMount(id)).toBe(true);
  for (let i = 0; i < CAST_TICKS; i++) sim.tick();
}

describe('mount tier ladder', () => {
  it('maps $WOC balance to the 11-rung ladder (0.1%, then 1%–10%)', () => {
    expect(mountTierForBalance(null)).toBe(0);
    expect(mountTierForBalance(0)).toBe(0);
    expect(mountTierForBalance(999_999)).toBe(0);     // below the 0.1% line
    expect(mountTierForBalance(1_000_000)).toBe(1);   // exactly 0.1%
    expect(mountTierForBalance(9_999_999)).toBe(1);
    expect(mountTierForBalance(10_000_000)).toBe(2);  // 1%
    expect(mountTierForBalance(50_000_000)).toBe(6);  // 5%
    expect(mountTierForBalance(99_999_999)).toBe(10); // just under 10%
    expect(mountTierForBalance(100_000_000)).toBe(11); // 10%
    expect(mountTierForBalance(250_000_000)).toBe(11); // capped at the top rung
  });

  it('has exactly 11 rungs with monotonic thresholds and the chosen speeds', () => {
    expect(MOUNT_LIST.length).toBe(11);
    for (let i = 0; i < MOUNT_LIST.length; i++) {
      expect(MOUNT_LIST[i].tier).toBe(i + 1);
      if (i > 0) expect(MOUNT_LIST[i].threshold).toBeGreaterThan(MOUNT_LIST[i - 1].threshold);
    }
    // 0.1% rides the normal ground mount, 1%+ rides the epic — no invented gradient.
    expect(MOUNT_LIST[0].speedMult).toBe(MOUNT_SPEED_NORMAL);
    for (let i = 1; i < MOUNT_LIST.length; i++) expect(MOUNT_LIST[i].speedMult).toBe(MOUNT_SPEED_EPIC);
  });

  it('gates ids against an eligibility tier', () => {
    expect(mountUnlockedAtTier('ashmane', 0)).toBe(false);
    expect(mountUnlockedAtTier('ashmane', 1)).toBe(true);
    expect(mountUnlockedAtTier('emberhoof', 1)).toBe(false);
    expect(mountUnlockedAtTier('emberhoof', 2)).toBe(true);
    expect(mountUnlockedAtTier('sovereign', 11)).toBe(true);
    expect(mountUnlockedAtTier('not-a-mount', 11)).toBe(false);
  });
});

describe('summon eligibility gating (server-authoritative in the Sim)', () => {
  it('rejects a mount above the rider\'s holdings, an unknown id, and ineligibility', () => {
    const { sim, p } = makeRider();
    p.mountTier = 0;
    expect(sim.summonMount('ashmane')).toBe(false);
    expect(sim.mountCast).toBeNull();

    p.mountTier = 1;
    expect(sim.summonMount('emberhoof')).toBe(false); // rung 2, not held
    expect(sim.summonMount('not-a-mount')).toBe(false);
    expect(sim.summonMount('ashmane')).toBe(true);    // rung 1, held
    expect(sim.mountCast?.id).toBe('ashmane');
  });

  it('completes the summon after the cast and sets the active steed', () => {
    const { sim, p } = makeRider();
    p.mountTier = 11;
    summonAndComplete(sim, 'sovereign');
    expect(p.mountId).toBe('sovereign');
    expect(sim.mountCast).toBeNull();
    expect(p.inCombat).toBe(false);
  });
});

describe('mount move-speed (the gameplay perk)', () => {
  it('applies the classic ground-mount multiplier only while mounted and out of combat', () => {
    const { sim, p } = makeRider();
    p.mountTier = 11;
    const mult = (e: typeof p) => (sim as unknown as { moveSpeedMult(x: typeof p): number }).moveSpeedMult(e);

    expect(mult(p)).toBeCloseTo(1.0); // unmounted

    summonAndComplete(sim, 'emberhoof'); // epic
    expect(p.mountId).toBe('emberhoof');
    expect(mult(p)).toBeCloseTo(MOUNT_SPEED_EPIC);

    // Already in the saddle: swapping to another steed is instant (no re-cast).
    expect(sim.summonMount('ashmane')).toBe(true);
    expect(sim.mountCast).toBeNull();
    expect(p.mountId).toBe('ashmane');
    expect(mult(p)).toBeCloseTo(MOUNT_SPEED_NORMAL);

    // Combat suppresses the boost even before the dismount lands.
    p.inCombat = true;
    expect(mult(p)).toBeCloseTo(1.0);
    p.inCombat = false;
  });
});

describe('dismount triggers', () => {
  it('throws the rider on entering combat', () => {
    const { sim, p } = makeRider();
    p.mountTier = 11;
    summonAndComplete(sim, 'sovereign');
    expect(p.mountId).toBe('sovereign');
    (sim as unknown as { enterCombat(a: typeof p, b: typeof p): void }).enterCombat(p, p);
    expect(p.mountId).toBeUndefined();
  });

  it('throws the rider on sourceless damage (falling), off the combat path', () => {
    const { sim, p } = makeRider();
    p.mountTier = 11;
    summonAndComplete(sim, 'sovereign');
    expect(p.mountId).toBe('sovereign');
    // Falling damage is dealt with a null source, so it never hits enterCombat.
    (sim as unknown as { dealDamage(s: null, t: typeof p, a: number, c: boolean, sc: string, ab: string, k: string, nr: boolean): void })
      .dealDamage(null, p, 5, false, 'physical', 'Falling', 'hit', true);
    expect(p.mountId).toBeUndefined();
  });

  it('cancels an in-progress summon when the rider moves', () => {
    const { sim, p } = makeRider();
    p.mountTier = 11;
    expect(sim.summonMount('sovereign')).toBe(true);
    expect(sim.mountCast).not.toBeNull();
    sim.moveInput.forward = true; // translational input cancels the cast
    sim.tick();
    expect(sim.mountCast).toBeNull();
    expect(p.mountId).toBeUndefined();
    sim.moveInput.forward = false;
  });

  it('dismisses on demand', () => {
    const { sim, p } = makeRider();
    p.mountTier = 11;
    summonAndComplete(sim, 'sovereign');
    expect(p.mountId).toBe('sovereign');
    sim.dismissMount();
    expect(p.mountId).toBeUndefined();
  });
});

describe('dynamic eligibility (sell-below-threshold)', () => {
  it('force-dismounts when holdings fall below the active rung, but keeps a still-eligible lower steed', () => {
    const { sim, p } = makeRider();
    p.mountTier = 11;
    summonAndComplete(sim, 'sovereign'); // rung 11
    expect(p.mountId).toBe('sovereign');

    p.mountTier = 5; // sold down below rung 11
    sim.enforceMountEligibility(sim.playerId);
    expect(p.mountId).toBeUndefined();

    // A rung the rider still covers is left in the saddle.
    p.mountTier = 11;
    summonAndComplete(sim, 'ashmane'); // rung 1
    expect(p.mountId).toBe('ashmane');
    p.mountTier = 3; // still ≥ rung 1
    sim.enforceMountEligibility(sim.playerId);
    expect(p.mountId).toBe('ashmane');
  });
});

describe('determinism', () => {
  it('produces the same mounted state from the same inputs', () => {
    const run = () => {
      const { sim, p } = makeRider();
      p.mountTier = 11;
      summonAndComplete(sim, MOUNTS.celestial.id);
      return { id: p.mountId, x: p.pos.x, z: p.pos.z };
    };
    expect(run()).toEqual(run());
  });
});
