import type { Entity, MoveInput, PlayerClass, WorldContent } from '../sim/types';

export interface IWorldEntityRoster {
  // `world` is the offline editor play-test world (carries render-only placements
  // for the renderer); optional and absent online.
  // `riverboatCasino` is the render/theming gate: true only on the casino realm,
  // so the renderer builds the moored saloon there and nowhere else. Optional
  // (absent reads false); the offline Sim sets it from SimConfig, the online
  // ClientWorld from the authoritative `hello` frame.
  cfg: { seed: number; playerClass: PlayerClass; world?: WorldContent; riverboatCasino?: boolean };
  entities: Map<number, Entity>;
  playerId: number;
  player: Entity;
  moveInput: MoveInput;
  // the realm (world/shard) this character lives on; '' in offline play
  realm: string;
}
