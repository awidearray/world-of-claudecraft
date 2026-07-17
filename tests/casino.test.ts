// The RiverBoat casino interaction seam (src/sim/casino.ts): interacting with a
// station croupier emits a casinoStation event the HUD turns into a window, and
// interacting with the gangway/exit boards or disembarks. Gated on the casino
// flag and on proximity; unknown fixtures no-op.

import { describe, expect, it } from 'vitest';
import { CASINO_STATIONS } from '../src/sim/casino';
import { isOnRiverboatDeck } from '../src/sim/data';
import { RIVERBOAT_GANGWAY_ID } from '../src/sim/instances/riverboat';
import { Sim } from '../src/sim/sim';
import type { Entity, SimEvent } from '../src/sim/types';

type AnySim = Sim & Record<string, any>;
type AnyEntity = Entity & Record<string, any>;

function makeCasinoSim(seed = 7): AnySim {
  return new Sim({ seed, playerClass: 'warrior', noPlayer: true, riverboatCasino: true }) as AnySim;
}
function teleport(sim: AnySim, e: AnyEntity, x: number, z: number): void {
  e.pos = { x, y: e.pos.y, z };
  e.prevPos = { ...e.pos };
  sim.rebucket(e);
}
function croupier(sim: AnySim, templateId: string): AnyEntity {
  return [...sim.entities.values()].find(
    (e: AnyEntity) => e.templateId === templateId,
  ) as AnyEntity;
}

describe('casino interaction seam', () => {
  it('emits casinoStation with the registry station when a croupier is interacted', () => {
    const sim = makeCasinoSim();
    const p = sim.entities.get(sim.addPlayer('warrior', 'P')) as AnyEntity;
    const dealer = croupier(sim, 'riverboat_dealer');
    teleport(sim, p, dealer.pos.x, dealer.pos.z);

    sim.casinoInteract(dealer.id, p.id);
    const out = sim.tick();
    const ev = out.find((e: SimEvent) => e.type === 'casinoStation') as
      | { type: 'casinoStation'; station: string }
      | undefined;
    expect(ev?.station).toBe(CASINO_STATIONS.riverboat_dealer); // 'card_duel'
  });

  it('does not emit for a croupier out of interact range', () => {
    const sim = makeCasinoSim();
    const p = sim.entities.get(sim.addPlayer('warrior', 'P')) as AnyEntity;
    const pit = croupier(sim, 'riverboat_pit_boss');
    teleport(sim, p, pit.pos.x + 40, pit.pos.z);
    sim.casinoInteract(pit.id, p.id);
    expect(sim.tick().some((e: SimEvent) => e.type === 'casinoStation')).toBe(false);
  });

  it('boards the player when the gangway is interacted', () => {
    const sim = makeCasinoSim();
    const p = sim.entities.get(sim.addPlayer('warrior', 'P')) as AnyEntity;
    const gangway = sim.entities.get(RIVERBOAT_GANGWAY_ID) as AnyEntity;
    teleport(sim, p, gangway.pos.x, gangway.pos.z);
    sim.casinoInteract(RIVERBOAT_GANGWAY_ID, p.id);
    expect(isOnRiverboatDeck(p.pos.x, p.pos.z)).toBe(true);
  });

  it('no-ops entirely when the realm does not run the casino', () => {
    const sim = new Sim({ seed: 7, playerClass: 'warrior', noPlayer: true }) as AnySim;
    const p = sim.entities.get(sim.addPlayer('warrior', 'P')) as AnyEntity;
    // Even naming a would-be croupier id: no casino, no emit, no move.
    sim.casinoInteract(1_000_000_004, p.id);
    expect(sim.tick().some((e: SimEvent) => e.type === 'casinoStation')).toBe(false);
    expect(isOnRiverboatDeck(p.pos.x, p.pos.z)).toBe(false);
  });
});
