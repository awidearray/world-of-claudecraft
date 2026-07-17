// The moored RiverBoat casino as a single fixed SHARED public instance
// (src/sim/instances/riverboat.ts): boarding the gangway lands every player in
// the same space, the deck exit walks them back to the mooring, and none of it
// exists unless the realm runs the casino (cfg.riverboatCasino).

import { describe, expect, it } from 'vitest';
import { isOnRiverboatDeck } from '../src/sim/data';
import {
  RIVERBOAT_EXIT_ID,
  RIVERBOAT_GANGWAY_ID,
  RIVERBOAT_MOORING,
  updateRiverboatDoorTriggers,
} from '../src/sim/instances/riverboat';
import { Sim } from '../src/sim/sim';
import type { Entity } from '../src/sim/types';

type AnySim = Sim & Record<string, any>;
type AnyEntity = Entity & Record<string, any>;

function makeCasinoSim(seed = 99): AnySim {
  return new Sim({ seed, playerClass: 'warrior', noPlayer: true, riverboatCasino: true }) as AnySim;
}

function teleport(sim: AnySim, e: AnyEntity, x: number, z: number): void {
  e.pos = { x, y: e.pos.y, z };
  e.prevPos = { ...e.pos };
  sim.rebucket(e);
}

describe('riverboat: shared-instance boarding', () => {
  it('spawns the gangway and deck-exit portals only when the casino is enabled', () => {
    const on = makeCasinoSim();
    expect(on.entities.get(RIVERBOAT_GANGWAY_ID)).toBeDefined();
    expect(on.entities.get(RIVERBOAT_EXIT_ID)).toBeDefined();

    const off = new Sim({ seed: 99, playerClass: 'warrior', noPlayer: true }) as AnySim;
    expect(off.entities.get(RIVERBOAT_GANGWAY_ID)).toBeUndefined();
    expect(off.entities.get(RIVERBOAT_EXIT_ID)).toBeUndefined();
  });

  it('walking onto the gangway boards the player onto the deck', () => {
    const sim = makeCasinoSim();
    const pid = sim.addPlayer('warrior', 'Gambler');
    const p = sim.entities.get(pid) as AnyEntity;
    const gangway = sim.entities.get(RIVERBOAT_GANGWAY_ID) as AnyEntity;
    teleport(sim, p, gangway.pos.x, gangway.pos.z);

    updateRiverboatDoorTriggers(sim.ctx, p);

    expect(isOnRiverboatDeck(p.pos.x, p.pos.z)).toBe(true);
  });

  it('walking onto the deck exit disembarks the player back to the mooring', () => {
    const sim = makeCasinoSim();
    const pid = sim.addPlayer('warrior', 'Gambler');
    const p = sim.entities.get(pid) as AnyEntity;
    const exit = sim.entities.get(RIVERBOAT_EXIT_ID) as AnyEntity;
    teleport(sim, p, exit.pos.x, exit.pos.z);

    updateRiverboatDoorTriggers(sim.ctx, p);

    expect(isOnRiverboatDeck(p.pos.x, p.pos.z)).toBe(false);
    expect(Math.abs(p.pos.x - RIVERBOAT_MOORING.x)).toBeLessThan(10);
  });

  it('two players share ONE deck space (no per-party instancing)', () => {
    const sim = makeCasinoSim();
    const a = sim.entities.get(sim.addPlayer('warrior', 'Aaa')) as AnyEntity;
    const b = sim.entities.get(sim.addPlayer('mage', 'Bbb')) as AnyEntity;
    const gangway = sim.entities.get(RIVERBOAT_GANGWAY_ID) as AnyEntity;

    teleport(sim, a, gangway.pos.x, gangway.pos.z);
    updateRiverboatDoorTriggers(sim.ctx, a);
    teleport(sim, b, gangway.pos.x, gangway.pos.z);
    updateRiverboatDoorTriggers(sim.ctx, b);

    // Both aboard, and no instance slot was ever allocated for the boat: they
    // land at the identical fixed origin, not two party-keyed copies.
    expect(isOnRiverboatDeck(a.pos.x, a.pos.z)).toBe(true);
    expect(isOnRiverboatDeck(b.pos.x, b.pos.z)).toBe(true);
    expect(a.pos.x).toBeCloseTo(b.pos.x, 5);
    expect(a.pos.z).toBeCloseTo(b.pos.z, 5);
    expect((sim.instances as unknown[]).some((i) => (i as any).dungeonId === 'riverboat')).toBe(
      false,
    );
  });

  it('the gangway is barred when the realm does not run the casino', () => {
    const sim = new Sim({ seed: 99, playerClass: 'warrior', noPlayer: true }) as AnySim;
    const pid = sim.addPlayer('warrior', 'Gambler');
    const p = sim.entities.get(pid) as AnyEntity;
    // Stand exactly where the gangway would be; with the casino off there is no
    // portal entity and the trigger no-ops, so the player never boards.
    teleport(sim, p, RIVERBOAT_MOORING.x, RIVERBOAT_MOORING.z);
    updateRiverboatDoorTriggers(sim.ctx, p);
    expect(isOnRiverboatDeck(p.pos.x, p.pos.z)).toBe(false);
  });
});
