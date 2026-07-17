// The RiverBoat casino interaction seam. One member: casinoInteract, which the
// client calls when a player interacts with a casino fixture (a croupier NPC, or
// the gangway/exit portals). The sim routes by the fixture's templateId: a
// station croupier emits a `casinoStation` event the HUD turns into that game's
// window (Mechanism B: the sim, not the client, decides the open, so the
// server's regulated-feature gate can veto it before any real-money game leaf
// acts); the gangway/exit board or disembark. Which stations exist is an
// append-only registry the game leaves extend (src/sim/casino.ts).
export interface IWorldCasino {
  casinoInteract(entityId: number): void;
}
