import { describe, expect, it } from 'vitest';
import { scoreRig } from '../src/net/rental';
import { tierForScore, HOST_MIN_SCORE } from '../server/rental';

describe('client rig scoring', () => {
  it('rewards a high-fps discrete GPU enough to clear the hosting bar', () => {
    const score = scoreRig({ fps: 144, cores: 16, renderer: 'NVIDIA GeForce RTX 4090', mobile: false });
    expect(score).toBeGreaterThanOrEqual(HOST_MIN_SCORE);
    expect(tierForScore(score)).toMatch(/high|ultra/);
  });

  it('keeps a weak integrated laptop below the hosting bar', () => {
    const score = scoreRig({ fps: 40, cores: 4, renderer: 'Intel(R) UHD Graphics 620', mobile: false });
    expect(score).toBeLessThan(HOST_MIN_SCORE);
    expect(tierForScore(score)).toMatch(/low|mid/);
  });

  it('penalizes mobile parts so phones rarely qualify to host', () => {
    const desktop = scoreRig({ fps: 60, cores: 8, renderer: 'Unknown', mobile: false });
    const phone = scoreRig({ fps: 60, cores: 8, renderer: 'Mali-G78', mobile: true });
    expect(phone).toBeLessThan(desktop);
    expect(phone).toBeLessThan(HOST_MIN_SCORE);
  });

  it('clamps to 0..100 for absurd inputs', () => {
    expect(scoreRig({ fps: 99999, cores: 9999, renderer: 'RTX 4090', mobile: false })).toBeLessThanOrEqual(100);
    expect(scoreRig({ fps: -5, cores: 0, renderer: 'llvmpipe', mobile: false })).toBeGreaterThanOrEqual(0);
  });
});
