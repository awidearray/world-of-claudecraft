// The RiverBoat casino interaction router (the IWorldCasino seam). One entry
// point, casinoInteract, resolves the fixture the player interacted with and
// routes by its templateId:
//   - a station croupier -> emit `casinoStation` so the HUD opens that game's
//     window (Mechanism B: the SIM decides the open, so a server-side
//     regulated-feature gate can veto before any money game leaf acts);
//   - the gangway / deck exit -> board or disembark.
// The station map is an APPEND-ONLY registry the game leaves extend (each leaf
// adds its croupier templateId -> station key here, never rewriting the others).
import {
  enterRiverboat,
  leaveRiverboat,
  RIVERBOAT_EXIT_TEMPLATE,
  RIVERBOAT_GANGWAY_TEMPLATE,
} from './instances/riverboat';
import type { SimContext } from './sim_context';
import { dist2d, INTERACT_RANGE } from './types';

// Croupier templateId -> station registry key. Append-only: a game leaf adds its
// station here and never edits another's row. The HUD's opener registry
// (CASINO_STATIONS in the HUD) mirrors these keys.
export const CASINO_STATIONS: Record<string, string> = {
  riverboat_dealer: 'card_duel',
  riverboat_pit_boss: 'wager_pit',
  riverboat_slots_attendant: 'slots',
  riverboat_hilo_croupier: 'hilo',
  riverboat_cashier_purser: 'cashier',
};

export function casinoInteract(ctx: SimContext, entityId: number, pid?: number): void {
  const r = ctx.resolve(pid);
  if (!r || !ctx.cfg.riverboatCasino) return;
  const fixture = ctx.entities.get(entityId);
  if (!fixture || dist2d(r.e.pos, fixture.pos) > INTERACT_RANGE) return;
  const template = fixture.templateId;
  if (template === RIVERBOAT_GANGWAY_TEMPLATE) {
    enterRiverboat(ctx, r.e.id);
    return;
  }
  if (template === RIVERBOAT_EXIT_TEMPLATE) {
    leaveRiverboat(ctx, r.e.id);
    return;
  }
  const station = template ? CASINO_STATIONS[template] : undefined;
  if (!station) return;
  ctx.emit({ type: 'casinoStation', pid: r.e.id, station });
}
