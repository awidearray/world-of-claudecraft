// The moored RiverBoat casino as ONE fixed, always-on SHARED public instance:
// every player who boards lands in the same space (no party keying, no instance
// slots, no claim/free/empty-timeout). This is deliberately LESS machinery than
// the dungeon instance system, not more: a single fixed origin (riverboatOrigin,
// src/sim/data.ts), a gangway door object in the overworld that walks a player
// aboard, and an exit portal on the deck that walks them back to the mooring.
//
// Entirely gated on cfg.riverboatCasino: the caller spawns the objects only on
// the casino realm, and the door triggers no-op elsewhere, so a non-casino realm
// never sees the boat. Reserved entity ids (outside the nextId sequence, after
// the rng-driven world roster) keep world-gen determinism and the parity goldens'
// pinned id sequence intact, exactly like the Vale Cup groundskeeper and Fury.
import {
  RIVERBOAT_CASHIER_PURSER_ID,
  RIVERBOAT_DEALER_ID,
  RIVERBOAT_HILO_CROUPIER_ID,
  RIVERBOAT_NPCS,
  RIVERBOAT_PIT_BOSS_ID,
  RIVERBOAT_SLOTS_ATTENDANT_ID,
} from '../content/riverboat';
import { riverboatOrigin } from '../data';
import { createGroundObject, createNpc } from '../entity';
import { GANGWAY_ENTRY, GANGWAY_EXIT } from '../riverboat_layout';
import type { SimContext } from '../sim_context';
import { dist2d, type Entity } from '../types';

// Reserved entity ids: Bram = 1_000_000_000, Fury = 1_000_000_001; the boat
// takes 002 (gangway) and 003 (exit), leaving 004+ for the croupier NPCs.
export const RIVERBOAT_GANGWAY_ID = 1_000_000_002;
export const RIVERBOAT_EXIT_ID = 1_000_000_003;

export const RIVERBOAT_GANGWAY_TEMPLATE = 'riverboat_gangway';
export const RIVERBOAT_EXIT_TEMPLATE = 'riverboat_exit';

// Croupier reserved ids (004-008), each paired with its NPC templateId. Ordered;
// spawnRiverboatCroupiers assigns ids by this order and never reuses one.
const CROUPIER_SPAWNS: ReadonlyArray<{ id: number; npcId: string }> = [
  { id: 1_000_000_004, npcId: RIVERBOAT_DEALER_ID },
  { id: 1_000_000_005, npcId: RIVERBOAT_PIT_BOSS_ID },
  { id: 1_000_000_006, npcId: RIVERBOAT_SLOTS_ATTENDANT_ID },
  { id: 1_000_000_007, npcId: RIVERBOAT_HILO_CROUPIER_ID },
  { id: 1_000_000_008, npcId: RIVERBOAT_CASHIER_PURSER_ID },
];

// Walking within this radius of the gangway (or the deck exit portal) teleports
// through it, no click required, mirroring the dungeon DOOR_TRIGGER_RADIUS.
const TRIGGER_RADIUS = 2.5;

// The overworld mooring: the boat is tied up at the south shore of the Eastbrook
// Vale lake (LAKE at {-92, 88} r30), so the gangway sits at the water's edge on
// land. Boarding lands the player at the stern gangway; leaving drops them a few
// yards inland of the gangway so they do not immediately re-trigger it.
export const RIVERBOAT_MOORING = { x: -92, z: 56 };
export const RIVERBOAT_MOORING_EXIT = { x: -92, z: 50 };

// Spawn the two portal objects (gangway in the overworld, exit on the deck) under
// reserved ids. Idempotent (guards on entity presence). The caller gates this on
// cfg.riverboatCasino, so it never runs on a non-casino realm.
export function spawnRiverboatDeck(ctx: SimContext): void {
  if (!ctx.entities.has(RIVERBOAT_GANGWAY_ID)) {
    const gangway = createGroundObject(
      RIVERBOAT_GANGWAY_ID,
      '',
      'RiverBoat Gangway',
      ctx.groundPos(RIVERBOAT_MOORING.x, RIVERBOAT_MOORING.z),
    );
    gangway.templateId = RIVERBOAT_GANGWAY_TEMPLATE;
    gangway.objectItemId = null;
    gangway.lootable = true; // interactable (walk-in triggers; also clickable)
    ctx.addEntity(gangway);
  }
  if (!ctx.entities.has(RIVERBOAT_EXIT_ID)) {
    const origin = riverboatOrigin();
    const exit = createGroundObject(
      RIVERBOAT_EXIT_ID,
      '',
      'Gangplank',
      ctx.groundPos(origin.x + GANGWAY_EXIT.x, origin.z + GANGWAY_EXIT.z),
    );
    exit.templateId = RIVERBOAT_EXIT_TEMPLATE;
    exit.objectItemId = null;
    exit.lootable = true;
    ctx.addEntity(exit);
  }
}

// Spawn the five croupiers on the deck under reserved ids. Draws no rng and
// guards on presence, so it is idempotent and determinism-safe. Their NpcDef
// pos is deck-local; the world position is riverboatOrigin() + that anchor.
export function spawnRiverboatCroupiers(ctx: SimContext): void {
  const origin = riverboatOrigin();
  for (const { id, npcId } of CROUPIER_SPAWNS) {
    if (ctx.entities.has(id)) continue;
    const def = RIVERBOAT_NPCS[npcId];
    if (!def) continue;
    const npc = createNpc(id, def, ctx.groundPos(origin.x + def.pos.x, origin.z + def.pos.z));
    ctx.addEntity(npc);
  }
}

/** Teleport a player onto the deck at the stern gangway entry. */
export function enterRiverboat(ctx: SimContext, pid?: number): void {
  const r = ctx.resolve(pid);
  if (!r) return;
  const origin = riverboatOrigin();
  r.e.pos = ctx.groundPos(origin.x + GANGWAY_ENTRY.x, origin.z + GANGWAY_ENTRY.z);
  r.e.prevPos = { ...r.e.pos };
}

/** Teleport a player off the deck, back to the overworld mooring. */
export function leaveRiverboat(ctx: SimContext, pid?: number): void {
  const r = ctx.resolve(pid);
  if (!r) return;
  r.e.pos = ctx.groundPos(RIVERBOAT_MOORING_EXIT.x, RIVERBOAT_MOORING_EXIT.z);
  r.e.prevPos = { ...r.e.pos };
}

// Per-player: walking into the gangway boards, walking into the deck exit portal
// disembarks. No-op unless this realm runs the casino. Kept separate from the
// dungeon door triggers so the two systems never couple.
export function updateRiverboatDoorTriggers(ctx: SimContext, p: Entity): void {
  if (p.kind !== 'player' || !ctx.cfg.riverboatCasino) return;
  const exit = ctx.entities.get(RIVERBOAT_EXIT_ID);
  if (exit && dist2d(p.pos, exit.pos) < TRIGGER_RADIUS) {
    leaveRiverboat(ctx, p.id);
    return;
  }
  const gangway = ctx.entities.get(RIVERBOAT_GANGWAY_ID);
  if (gangway && dist2d(p.pos, gangway.pos) < TRIGGER_RADIUS) {
    enterRiverboat(ctx, p.id);
  }
}
