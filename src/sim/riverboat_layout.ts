// The moored RiverBoat casino deck as plain numbers, the single source of truth
// for BOTH the render dressing (src/render/riverboat_saloon.ts) and the interior
// collision set (src/sim/colliders.ts RIVERBOAT_COLLIDERS via layoutColliders).
// A pure leaf (no SimContext, no three.js), sibling of dungeon_layout.ts and
// vale_cup_layout.ts.
//
// The boat is ONE flat rectangular deck (the far-band floor is flat, so true
// vertical decks are impossible; the "multi-deck" feel is adjacent footprints on
// the one plane, joined by cosmetic companionways): the casino floor aft, the
// sportsbook forward, the cashier cage at the bow. Coordinates are INSTANCE-LOCAL
// (y up, z running bow-to-stern), placed in the world at riverboatOrigin() (see
// src/sim/data.ts). The tapered-bow silhouette is cosmetic render geometry only;
// collision is the rectangular hull, matching every shipped dungeon.
import type { DungeonLayout } from './dungeon_layout';

// Local half-extents. The hull is 120u long (z -60 bow .. +60 stern) and 26u
// half-beam walkable (side wall centre at |x| = 27), a long paddle-steamer.
export const RIVERBOAT_HALF_BEAM = 27; // side-wall centreline (|x|)
export const RIVERBOAT_Z_MIN = -60; // bow (front) wall centreline
export const RIVERBOAT_Z_MAX = 60; // stern (aft) wall centreline
// The gameplay footprint half-extents (walls + a small margin), used by
// isOnRiverboatDeck to answer "is this position on the boat".
export const RIVERBOAT_FOOTPRINT_HALF_X = RIVERBOAT_HALF_BEAM + 2; // 29
export const RIVERBOAT_FOOTPRINT_HALF_Z = 66;

// An instance-local anchor: where a station prop / NPC / trigger sits on the deck.
export interface DeckAnchor {
  x: number;
  z: number;
}

// Station anchor coordinates (instance-local). Game leaves append their own
// station-specific anchors as needed but never move these. Layout, bow (-z) to
// stern (+z): cashier cage at the bow, sportsbook amidships-forward, casino floor
// aft, gangway at the stern where players board.
export const GANGWAY_ENTRY: DeckAnchor = { x: 0, z: 54 }; // where boarders arrive
export const GANGWAY_EXIT: DeckAnchor = { x: 0, z: 62 }; // just off the stern, back to the mooring
export const CASHIER_CAGE: DeckAnchor = { x: 0, z: -52 };
export const SPORTSBOOK_SCREENS: readonly DeckAnchor[] = [
  { x: -20, z: -30 },
  { x: -7, z: -32 },
  { x: 7, z: -32 },
  { x: 20, z: -30 },
];
export const SPORTSBOOK_TICKET_WINDOW: DeckAnchor = { x: 0, z: -22 };
export const HILO_TABLE: DeckAnchor = { x: -16, z: -2 };
export const WAGER_PIT: DeckAnchor = { x: 0, z: 8 };
export const CARD_TABLE_ANCHORS: readonly DeckAnchor[] = [
  { x: -18, z: 24 },
  { x: 18, z: 24 },
  { x: -18, z: 38 },
  { x: 18, z: 38 },
];
export const SLOTS_CORNER: readonly DeckAnchor[] = [
  { x: -22, z: 42 },
  { x: -22, z: 48 },
  { x: -14, z: 50 },
];
export const GACHA_CABINETS: readonly DeckAnchor[] = [
  { x: 22, z: 42 },
  { x: 22, z: 48 },
  { x: 14, z: 50 },
];

// The rectangular hull. sideWall/wallX give the beam; the partitions between the
// three zones (casino / sportsbook / cashier) are `stubs`; wall-side furniture
// (card tables, slot cabinets, the cashier counter) are `tombs` (OBB obstacles);
// stools are `clutter`. Everything is derived by layoutColliders into a
// rectangular collision shell plus these obstacle circles/boxes.
export const RIVERBOAT_LAYOUT: DungeonLayout = {
  zMin: RIVERBOAT_Z_MIN,
  zMax: RIVERBOAT_Z_MAX,
  sideWallZ: 0,
  sideWallHd: RIVERBOAT_FOOTPRINT_HALF_Z,
  wallX: RIVERBOAT_HALF_BEAM,
  endWallHw: RIVERBOAT_HALF_BEAM,
  floorHalfX: RIVERBOAT_HALF_BEAM,
  // Centre-aisle stanchions (render mounts lanterns on these).
  pillars: [
    { x: 0, z: -40 },
    { x: 0, z: -12 },
    { x: 0, z: 16 },
    { x: 0, z: 44 },
  ],
  // Wall-side furniture footprints: card tables, slot/gacha cabinets, the
  // cashier counter, the hi-lo table. OBBs (TOMB_HW x TOMB_HD) the mover slides on.
  tombs: [
    ...CARD_TABLE_ANCHORS,
    ...SLOTS_CORNER,
    ...GACHA_CABINETS,
    HILO_TABLE,
    { x: 0, z: -56 }, // cashier counter (bow wall)
  ],
  // Partition stubs between the three zones (cashier | sportsbook | casino).
  stubs: [
    { x: -24, z: -16, hw: 3, hd: 1 },
    { x: 24, z: -16, hw: 3, hd: 1 },
    { x: -24, z: 18, hw: 3, hd: 1 },
    { x: 24, z: 18, hw: 3, hd: 1 },
  ],
  // No boss dais; a walkable centre with no collider at the wager pit.
  dais: { x: WAGER_PIT.x, z: WAGER_PIT.z, r: 6 },
  // The gangway archway at the stern; render places the boarding gate here.
  doorZ: RIVERBOAT_Z_MAX,
  // Stools scattered by the tables (render props + collision circles).
  clutter: [
    { x: -13, z: 24 },
    { x: 13, z: 24 },
    { x: -13, z: 38 },
    { x: 13, z: 38 },
    { x: -11, z: -2 },
  ],
};
