// The RiverBoat Hi-Lo fair roller (server/hilo.ts): rolls are always 1..100,
// the nonce advances per account, and a fixed secret makes the sequence
// reproducible (so a test can pin it) while a different secret or client seed
// changes it (so the player cannot predict it).

import { describe, expect, it } from 'vitest';
import { HiloRoller } from '../../server/hilo';

const SECRET = Buffer.alloc(32, 7); // fixed so the sequence is deterministic here

describe('HiloRoller', () => {
  it('always returns a roll in 1..100', () => {
    const roller = new HiloRoller(SECRET);
    for (let i = 0; i < 2000; i++) {
      const { roll } = roller.roll(i % 5, `seed-${i}`);
      expect(roll).toBeGreaterThanOrEqual(1);
      expect(roll).toBeLessThanOrEqual(100);
    }
  });

  it('advances a monotonic per-account nonce', () => {
    const roller = new HiloRoller(SECRET);
    expect(roller.roll(1, 'a').nonce).toBe(1);
    expect(roller.roll(1, 'a').nonce).toBe(2);
    expect(roller.roll(2, 'a').nonce).toBe(1); // a different account starts fresh
    expect(roller.roll(1, 'a').nonce).toBe(3);
  });

  it('is reproducible for the same (secret, account, nonce, clientSeed)', () => {
    const a = new HiloRoller(SECRET);
    const b = new HiloRoller(SECRET);
    expect(a.roll(9, 'lucky').roll).toBe(b.roll(9, 'lucky').roll);
  });

  it('changes with the client seed and with the secret (unpredictable)', () => {
    const a = new HiloRoller(SECRET);
    const b = new HiloRoller(SECRET);
    // Same account+nonce, different client seed: a divergence somewhere in a
    // short run proves the seed feeds the roll (a single value could collide).
    let differsBySeed = false;
    for (let i = 0; i < 40; i++) {
      if (a.roll(1, `x${i}`).roll !== b.roll(1, `y${i}`).roll) differsBySeed = true;
    }
    expect(differsBySeed).toBe(true);

    const other = new HiloRoller(Buffer.alloc(32, 200));
    let differsBySecret = false;
    for (let i = 0; i < 40; i++) {
      if (new HiloRoller(SECRET).roll(1, `s${i}`).roll !== other.roll(1, `s${i}`).roll)
        differsBySecret = true;
    }
    expect(differsBySecret).toBe(true);
  });
});
