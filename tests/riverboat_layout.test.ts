import { describe, expect, it } from 'vitest';
import { resolvePosition } from '../src/sim/colliders';
import {
  isOnRiverboatDeck,
  isRiverboatBandPos,
  RIVERBOAT_BAND_X_MAX,
  RIVERBOAT_BAND_X_MIN,
  RIVERBOAT_X,
  RIVERBOAT_Z,
  riverboatOrigin,
  YUMI_BAND_X_MAX,
} from '../src/sim/data';
import {
  CARD_TABLE_ANCHORS,
  GANGWAY_ENTRY,
  RIVERBOAT_FOOTPRINT_HALF_X,
  RIVERBOAT_FOOTPRINT_HALF_Z,
  RIVERBOAT_HALF_BEAM,
  RIVERBOAT_LAYOUT,
  SPORTSBOOK_SCREENS,
  WAGER_PIT,
} from '../src/sim/riverboat_layout';

describe('RiverBoat band placement', () => {
  it('sits past the yumi band and well before the Vale Cup practice pitches', () => {
    // No overlap with the yumi maze band (which caps at 12000) or anything below.
    expect(RIVERBOAT_BAND_X_MIN).toBeGreaterThan(YUMI_BAND_X_MAX);
    expect(RIVERBOAT_X).toBeGreaterThan(RIVERBOAT_BAND_X_MIN);
    expect(RIVERBOAT_X).toBeLessThan(RIVERBOAT_BAND_X_MAX);
    // The Vale Cup practice pitches live at x=30000; the boat band is far short of them.
    expect(RIVERBOAT_BAND_X_MAX).toBeLessThan(30000);
  });

  it('routes only its own band', () => {
    expect(isRiverboatBandPos(RIVERBOAT_X)).toBe(true);
    expect(isRiverboatBandPos(RIVERBOAT_BAND_X_MIN - 1)).toBe(false);
    expect(isRiverboatBandPos(RIVERBOAT_BAND_X_MAX)).toBe(false);
    // A position inside the yumi band never reads as riverboat.
    expect(isRiverboatBandPos(9600)).toBe(false);
  });

  it('riverboatOrigin is the band centre', () => {
    expect(riverboatOrigin()).toEqual({ x: RIVERBOAT_X, z: RIVERBOAT_Z });
  });
});

describe('isOnRiverboatDeck footprint', () => {
  it('is true at the origin and false past the hull footprint', () => {
    expect(isOnRiverboatDeck(RIVERBOAT_X, RIVERBOAT_Z)).toBe(true);
    expect(isOnRiverboatDeck(RIVERBOAT_X + RIVERBOAT_FOOTPRINT_HALF_X - 1, RIVERBOAT_Z)).toBe(true);
    expect(isOnRiverboatDeck(RIVERBOAT_X + RIVERBOAT_FOOTPRINT_HALF_X + 5, RIVERBOAT_Z)).toBe(
      false,
    );
    expect(isOnRiverboatDeck(RIVERBOAT_X, RIVERBOAT_Z + RIVERBOAT_FOOTPRINT_HALF_Z + 5)).toBe(
      false,
    );
  });
});

describe('RIVERBOAT_LAYOUT + station anchors', () => {
  const halfBeam = RIVERBOAT_HALF_BEAM;
  const anchors = [...CARD_TABLE_ANCHORS, ...SPORTSBOOK_SCREENS, WAGER_PIT, GANGWAY_ENTRY];

  it('every station anchor sits inside the walkable hull (|x| < beam, within z walls)', () => {
    for (const a of anchors) {
      expect(Math.abs(a.x)).toBeLessThanOrEqual(halfBeam);
      expect(a.z).toBeGreaterThanOrEqual(RIVERBOAT_LAYOUT.zMin);
      expect(a.z).toBeLessThanOrEqual(RIVERBOAT_LAYOUT.zMax);
    }
  });

  it('the gangway entry is walkable (not stuck inside a collider)', () => {
    const world = { x: RIVERBOAT_X + GANGWAY_ENTRY.x, z: RIVERBOAT_Z + GANGWAY_ENTRY.z };
    // A body placed at the gangway entry resolves to (approximately) itself: it is
    // not embedded in a wall/prop, so a boarding player can stand there.
    const resolved = resolvePosition(1, world.x, world.z, 0.5);
    expect(Math.hypot(resolved.x - world.x, resolved.z - world.z)).toBeLessThan(2);
  });

  it('a body embedded in the side wall is pushed back inside the beam', () => {
    // A point placed INSIDE the starboard wall obstacle (just past the inner
    // face at |x|=beam-1) resolves back into the walkable interior (|x| < beam).
    const inWall = { x: RIVERBOAT_X + (halfBeam - 0.8), z: RIVERBOAT_Z };
    const resolved = resolvePosition(1, inWall.x, inWall.z, 0.5);
    expect(resolved.x - RIVERBOAT_X).toBeLessThan(halfBeam - 1);
  });

  it('a station prop (card table) displaces a body placed on it', () => {
    // A card-table anchor is a solid obstacle: a body dropped on its centre is
    // pushed off, proving the furniture colliders route through RIVERBOAT_COLLIDERS.
    const table = CARD_TABLE_ANCHORS[0];
    const world = { x: RIVERBOAT_X + table.x, z: RIVERBOAT_Z + table.z };
    const resolved = resolvePosition(1, world.x, world.z, 0.5);
    expect(Math.hypot(resolved.x - world.x, resolved.z - world.z)).toBeGreaterThan(0.4);
  });
});
