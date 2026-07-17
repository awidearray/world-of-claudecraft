// The RiverBoat casino croupiers: five dynamic NPCs stationed on the deck, one
// per game station. All `dynamic: true` so the generic surface-placement loop
// skips them; the boat instance module spawns them at world init under reserved
// entity ids (after the rng-driven roster) ONLY when cfg.riverboatCasino, so a
// non-casino realm never sees them and the parity goldens' id sequence is intact
// (the Vale Cup groundskeeper / Fury precedent).
//
// `pos` here is DECK-LOCAL (relative to riverboatOrigin), unlike overworld NPCs
// whose pos is a world coordinate. That is safe: a dynamic NPC is never
// surface-placed from its def.pos, and the spawn helper resolves the world
// position as origin + anchor. This keeps content/ free of a data.ts import
// (data.ts merges content/, so importing it back would be a cycle).
import {
  CARD_TABLE_ANCHORS,
  CASHIER_CAGE,
  HILO_TABLE,
  SLOTS_CORNER,
  WAGER_PIT,
} from '../riverboat_layout';
import type { NpcDef } from '../types';

// The station templateIds a croupier carries; the interaction seam maps these to
// their game window. Exported so the instance spawner and the interaction
// registry share one source of truth.
export const RIVERBOAT_DEALER_ID = 'riverboat_dealer';
export const RIVERBOAT_PIT_BOSS_ID = 'riverboat_pit_boss';
export const RIVERBOAT_SLOTS_ATTENDANT_ID = 'riverboat_slots_attendant';
export const RIVERBOAT_HILO_CROUPIER_ID = 'riverboat_hilo_croupier';
export const RIVERBOAT_CASHIER_PURSER_ID = 'riverboat_cashier_purser';

const BRASS = 0xc9a227; // the Gilded Strongbox banker gold, the boat's brass fittings
const VELVET = 0x7a1f2b; // crimson velvet

export const RIVERBOAT_NPCS: Record<string, NpcDef> = {
  [RIVERBOAT_DEALER_ID]: {
    id: RIVERBOAT_DEALER_ID,
    name: 'Dealer Maribel',
    title: 'Cardsharp of the Grand Saloon',
    pos: { x: CARD_TABLE_ANCHORS[0].x, z: CARD_TABLE_ANCHORS[0].z },
    facing: 0,
    color: VELVET,
    questIds: [],
    dynamic: true,
    greeting: 'Pull up a chair, $C. The deck is fresh and the deal is honest. Care for a hand?',
  },
  [RIVERBOAT_PIT_BOSS_ID]: {
    id: RIVERBOAT_PIT_BOSS_ID,
    name: 'Pit Boss Crake',
    title: 'Master of the Wager Ring',
    pos: { x: WAGER_PIT.x, z: WAGER_PIT.z },
    facing: Math.PI,
    color: VELVET,
    questIds: [],
    dynamic: true,
    greeting: 'Two fighters, one purse, $C. Step to the ring and name your stake.',
  },
  [RIVERBOAT_SLOTS_ATTENDANT_ID]: {
    id: RIVERBOAT_SLOTS_ATTENDANT_ID,
    name: 'Tilly Sprocket',
    title: 'Keeper of the Reels',
    pos: { x: SLOTS_CORNER[0].x, z: SLOTS_CORNER[0].z },
    facing: 0,
    color: BRASS,
    questIds: [],
    dynamic: true,
    greeting: 'The cabinets are oiled and eager, $C. One free pull a day, and the reels never lie.',
  },
  [RIVERBOAT_HILO_CROUPIER_ID]: {
    id: RIVERBOAT_HILO_CROUPIER_ID,
    name: 'Quartermaster Nock',
    title: 'Caller of the Bones',
    pos: { x: HILO_TABLE.x, z: HILO_TABLE.z },
    facing: 0,
    color: BRASS,
    questIds: [],
    dynamic: true,
    greeting: 'High or low, $C, a single roll settles it. The house keeps only the middle.',
  },
  [RIVERBOAT_CASHIER_PURSER_ID]: {
    id: RIVERBOAT_CASHIER_PURSER_ID,
    name: 'Purser Odalie Finch',
    title: 'Keeper of the Cage',
    pos: { x: CASHIER_CAGE.x, z: CASHIER_CAGE.z },
    facing: Math.PI,
    color: BRASS,
    questIds: [],
    dynamic: true,
    greeting: 'The cage is open, $C. Chips in, coin out, and every ledger balances by dawn.',
  },
};
