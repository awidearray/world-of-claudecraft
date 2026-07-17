// Quartermaster's Hi-Lo resolution (src/sim/social/riverboat_hilo.ts): copper
// conservation, the win/lose ranges and the 2% house band, the record, and the
// proximity + funds guards. The roll is supplied (as the server does), so these
// are deterministic without a server secret.

import { describe, expect, it } from 'vitest';
import { Sim } from '../src/sim/sim';
import {
  HILO_HIGH_MIN,
  HILO_LOW_MAX,
  HILO_MAX_STAKE,
  HILO_MIN_STAKE,
  hiloWins,
} from '../src/sim/social/riverboat_hilo';
import type { Entity } from '../src/sim/types';

type AnySim = Sim & Record<string, any>;
type AnyEntity = Entity & Record<string, any>;

function makeCasinoSim(seed = 5): AnySim {
  return new Sim({ seed, playerClass: 'warrior', noPlayer: true, riverboatCasino: true }) as AnySim;
}
// Place the player right on the hi-lo croupier so the proximity gate passes.
function seatAtTable(sim: AnySim, copper: number): { pid: number; p: AnyEntity; meta: any } {
  const pid = sim.addPlayer('warrior', 'Roller');
  const p = sim.entities.get(pid) as AnyEntity;
  const nock = [...sim.entities.values()].find(
    (e: AnyEntity) => e.templateId === 'riverboat_hilo_croupier',
  ) as AnyEntity;
  p.pos = { x: nock.pos.x, y: p.pos.y, z: nock.pos.z };
  p.prevPos = { ...p.pos };
  sim.rebucket(p);
  const meta = [...sim.players.values()].find((m: any) => m.entityId === pid) as any;
  meta.copper = copper;
  return { pid, p, meta };
}

describe('hiloWins ranges', () => {
  it('lo wins 1..49, hi wins 52..100, and 50/51 lose for both (the house band)', () => {
    expect(hiloWins('lo', 1)).toBe(true);
    expect(hiloWins('lo', HILO_LOW_MAX)).toBe(true);
    expect(hiloWins('lo', 50)).toBe(false);
    expect(hiloWins('lo', 51)).toBe(false);
    expect(hiloWins('hi', 50)).toBe(false);
    expect(hiloWins('hi', 51)).toBe(false);
    expect(hiloWins('hi', HILO_HIGH_MIN)).toBe(true);
    expect(hiloWins('hi', 100)).toBe(true);
    // The band is exactly 2 of 100 numbers = the 2% edge.
    let houseWins = 0;
    for (let r = 1; r <= 100; r++) if (!hiloWins('lo', r) && !hiloWins('hi', r)) houseWins++;
    expect(houseWins).toBe(2);
  });
});

describe('hiloResolve conservation + records', () => {
  it('a winning call pays 2x and books the net gain', () => {
    const sim = makeCasinoSim();
    const { pid, meta } = seatAtTable(sim, 1000);
    sim.hiloResolve(pid, 'lo', 100, 10); // roll 10 <= 49 -> lo wins
    expect(meta.copper).toBe(1000 - 100 + 200); // debit 100, credit 2x
    expect(meta.hiloWins).toBe(1);
    expect(meta.hiloLosses).toBe(0);
    expect(meta.hiloNet).toBe(100);
  });

  it('a losing call keeps the stake and books the net loss', () => {
    const sim = makeCasinoSim();
    const { pid, meta } = seatAtTable(sim, 1000);
    sim.hiloResolve(pid, 'hi', 100, 10); // roll 10 -> hi loses
    expect(meta.copper).toBe(900);
    expect(meta.hiloLosses).toBe(1);
    expect(meta.hiloNet).toBe(-100);
  });

  it('the house band (50/51) always loses for the player', () => {
    const sim = makeCasinoSim();
    const { pid, meta } = seatAtTable(sim, 1000);
    sim.hiloResolve(pid, 'lo', 100, 50);
    sim.hiloResolve(pid, 'hi', 100, 51);
    expect(meta.copper).toBe(800);
    expect(meta.hiloLosses).toBe(2);
  });

  it('emits hiloSettled with the outcome', () => {
    const sim = makeCasinoSim();
    const { pid } = seatAtTable(sim, 1000);
    sim.hiloResolve(pid, 'hi', 50, 99);
    const ev = sim.tick().find((e: any) => e.type === 'hiloSettled');
    expect(ev).toMatchObject({ call: 'hi', stake: 50, roll: 99, outcome: 'win', payout: 100 });
  });
});

describe('hiloResolve guards (silent reject, copper untouched)', () => {
  it('rejects an out-of-bounds stake', () => {
    const sim = makeCasinoSim();
    const { pid, meta } = seatAtTable(sim, 1_000_000);
    sim.hiloResolve(pid, 'lo', HILO_MIN_STAKE - 1, 10);
    sim.hiloResolve(pid, 'lo', HILO_MAX_STAKE + 1, 10);
    expect(meta.copper).toBe(1_000_000);
    expect(meta.hiloWins + meta.hiloLosses).toBe(0);
  });

  it('rejects a stake the player cannot afford', () => {
    const sim = makeCasinoSim();
    const { pid, meta } = seatAtTable(sim, 50);
    sim.hiloResolve(pid, 'lo', 100, 10);
    expect(meta.copper).toBe(50);
    expect(meta.hiloWins).toBe(0);
  });

  it('rejects a play made away from the croupier', () => {
    const sim = makeCasinoSim();
    const pid = sim.addPlayer('warrior', 'FarOff');
    const meta = [...sim.players.values()].find((m: any) => m.entityId === pid) as any;
    meta.copper = 1000;
    // default spawn is far from the boat deck; no proximity -> reject
    sim.hiloResolve(pid, 'lo', 100, 10);
    expect(meta.copper).toBe(1000);
  });
});
