// Pure view-core for the Hi-Lo window: decides, from the player's copper and the
// chosen stake, which stake rungs are affordable and whether a play is legal,
// and normalizes a settled result into a display shape. DOM/i18n-free (returns
// data + amounts; the window renders the text), so a Vitest drives it directly.
// Mirrors the sim's HILO_MIN_STAKE / HILO_MAX_STAKE bounds.

export const HILO_MIN_STAKE = 10;
export const HILO_MAX_STAKE = 100_000;

// The stake ladder in copper: 10c, 1s, 10s, 1g, 10g. All within the sim bounds.
export const HILO_STAKE_LADDER: readonly number[] = [10, 100, 1000, 10_000, 100_000];

export interface HiloStakeOption {
  copper: number;
  affordable: boolean;
  selected: boolean;
}

export interface HiloView {
  copper: number;
  stake: number;
  stakes: HiloStakeOption[];
  // A play is legal only when the stake is within bounds and affordable.
  canPlay: boolean;
}

/** Clamp an arbitrary stake to the ladder-legal, in-bounds set. */
export function clampHiloStake(stake: number): number {
  if (!Number.isFinite(stake)) return HILO_MIN_STAKE;
  return Math.max(HILO_MIN_STAKE, Math.min(HILO_MAX_STAKE, Math.floor(stake)));
}

export function hiloView(copper: number, stake: number): HiloView {
  const s = clampHiloStake(stake);
  const stakes: HiloStakeOption[] = HILO_STAKE_LADDER.map((c) => ({
    copper: c,
    affordable: copper >= c,
    selected: c === s,
  }));
  return {
    copper,
    stake: s,
    stakes,
    canPlay: s >= HILO_MIN_STAKE && s <= HILO_MAX_STAKE && copper >= s,
  };
}

export interface HiloSettledResult {
  call: 'hi' | 'lo';
  stake: number;
  roll: number;
  outcome: 'win' | 'lose';
  payout: number;
}

// The running session tally the window shows (this login only; the persisted
// lifetime record is server state, not needed for play).
export interface HiloSession {
  wins: number;
  losses: number;
  net: number;
}

export function foldHiloResult(prev: HiloSession, r: HiloSettledResult): HiloSession {
  if (r.outcome === 'win') {
    return { wins: prev.wins + 1, losses: prev.losses, net: prev.net + r.stake };
  }
  return { wins: prev.wins, losses: prev.losses + 1, net: prev.net - r.stake };
}
