// The Hi-Lo window's pure core (src/ui/hilo_view.ts): stake clamping, affordable
// rungs, play legality, and the session fold.

import { describe, expect, it } from 'vitest';
import {
  clampHiloStake,
  foldHiloResult,
  HILO_MAX_STAKE,
  HILO_MIN_STAKE,
  HILO_STAKE_LADDER,
  hiloView,
} from '../src/ui/hilo_view';

describe('clampHiloStake', () => {
  it('clamps to the sim bounds and floors', () => {
    expect(clampHiloStake(0)).toBe(HILO_MIN_STAKE);
    expect(clampHiloStake(HILO_MAX_STAKE + 1)).toBe(HILO_MAX_STAKE);
    expect(clampHiloStake(123.9)).toBe(123);
    expect(clampHiloStake(Number.NaN)).toBe(HILO_MIN_STAKE);
  });
});

describe('hiloView', () => {
  it('marks affordable rungs and legality against copper', () => {
    const view = hiloView(500, 100);
    expect(view.stake).toBe(100);
    expect(view.canPlay).toBe(true);
    const affordable = view.stakes.filter((s) => s.affordable).map((s) => s.copper);
    expect(affordable).toEqual(HILO_STAKE_LADDER.filter((c) => c <= 500));
    expect(view.stakes.find((s) => s.copper === 100)?.selected).toBe(true);
  });

  it('cannot play a stake it cannot afford', () => {
    expect(hiloView(50, 100).canPlay).toBe(false);
    expect(hiloView(100, 100).canPlay).toBe(true);
  });
});

describe('foldHiloResult', () => {
  it('accumulates wins, losses, and net copper', () => {
    let s = { wins: 0, losses: 0, net: 0 };
    s = foldHiloResult(s, { call: 'lo', stake: 100, roll: 10, outcome: 'win', payout: 200 });
    s = foldHiloResult(s, { call: 'hi', stake: 100, roll: 10, outcome: 'lose', payout: 0 });
    expect(s).toEqual({ wins: 1, losses: 1, net: 0 });
  });
});
