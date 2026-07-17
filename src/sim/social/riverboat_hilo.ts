// Quartermaster's Hi-Lo: the RiverBoat's house-banked dice call. Stake copper,
// call HIGH or LOW on a 1 to 100 roll. LOW wins on 1 to 49, HIGH wins on 52 to
// 100, and 50 to 51 is the HOUSE BAND, the whole of the 2% edge over the 100
// numbers. An even-money game: a win pays 2x the stake back (stake returned plus
// the same again).
//
// The roll is NOT drawn from ctx.rng in online play: a client running the same
// deterministic sim could predict it, and this decides money. The SERVER derives
// the 1 to 100 roll from a server-held secret plus a player-supplied client seed
// (server/hilo.ts) and passes it in as a command input, so the sim stays
// deterministic and parity-neutral. Offline single-player uses ctx.rng (no
// adversary), via Sim.hiloPlay. Either way the resolution below is identical.
import type { SimContext } from '../sim_context';
import { dist2d, INTERACT_RANGE, type Vec3 } from '../types';

export type HiloCall = 'hi' | 'lo';
export type HiloOutcome = 'win' | 'lose';

// Stake bounds (copper): 10 copper to 10 gold.
export const HILO_MIN_STAKE = 10;
export const HILO_MAX_STAKE = 100_000;
// Winning ranges on a 1 to 100 roll; 50 and 51 fall in neither (the house band).
export const HILO_LOW_MAX = 49;
export const HILO_HIGH_MIN = 52;
// The croupier a player must stand near to play.
export const HILO_CROUPIER_TEMPLATE = 'riverboat_hilo_croupier';

/** True when the resulting roll wins for the given call. */
export function hiloWins(call: HiloCall, roll: number): boolean {
  if (call === 'lo') return roll <= HILO_LOW_MAX;
  return roll >= HILO_HIGH_MIN;
}

// Is the player standing at Quartermaster Nock's table?
function nearHiloCroupier(ctx: SimContext, pos: Vec3): boolean {
  for (const e of ctx.entities.values()) {
    if (e.templateId === HILO_CROUPIER_TEMPLATE && dist2d(pos, e.pos) <= INTERACT_RANGE + 2) {
      return true;
    }
  }
  return false;
}

// Resolve one Hi-Lo play. `roll` is the authoritative 1 to 100 outcome supplied
// by the caller (the server's fair roll, or the offline rng). Validates the
// realm flag, the call, the stake bounds, funds, and proximity, then debits the
// stake, pays 2x on a win, updates the record, and emits hiloSettled. A rejected
// play emits a player error and leaves copper untouched.
export function hiloResolve(
  ctx: SimContext,
  pid: number | undefined,
  call: HiloCall,
  stake: number,
  roll: number,
): void {
  // Every guard is a SILENT reject (defense in depth): the client pre-validates
  // stake bounds, funds, and proximity and shows the player-facing message, so
  // the sim never needs to emit prose here. A rejected play leaves copper
  // untouched and emits nothing.
  const r = ctx.resolve(pid);
  if (!r || !ctx.cfg.riverboatCasino) return;
  const { meta, e } = r;
  if (call !== 'hi' && call !== 'lo') return;
  if (!Number.isInteger(roll) || roll < 1 || roll > 100) return;
  if (!Number.isInteger(stake) || stake < HILO_MIN_STAKE || stake > HILO_MAX_STAKE) return;
  if (!nearHiloCroupier(ctx, e.pos)) return;
  if (meta.copper < stake) return;
  meta.copper -= stake;
  const won = hiloWins(call, roll);
  let payout = 0;
  if (won) {
    payout = stake * 2;
    meta.copper += payout;
    meta.hiloWins += 1;
    meta.hiloNet += stake;
  } else {
    meta.hiloLosses += 1;
    meta.hiloNet -= stake;
  }
  ctx.emit({
    type: 'hiloSettled',
    pid: e.id,
    call,
    stake,
    roll,
    outcome: won ? 'win' : 'lose',
    payout,
  });
}
