// The RiverBoat Hi-Lo fair roll. The 1 to 100 outcome is derived server-side so a
// client running the same deterministic sim cannot predict it: it is a SHA-256 of
// a server-held secret, the account id, a per-account monotonic nonce, and the
// player-supplied client seed. The secret makes it unpredictable to the player;
// the client seed makes it ungrindable by the house (the server cannot search
// seeds to target a specific player, since the player picks their seed).
//
// Fairness posture (copper / Model A): this is server-secret entropy, NOT the
// publicly-verifiable daily-seed commit-reveal the spinner uses. That is
// deliberate and sufficient for a soft-currency game with a fixed house edge; a
// $WOC-denominated Hi-Lo would first need the persisted daily seed plus the
// public reveal endpoint (the same infrastructure the slots/pack leaf carries),
// which is gated by absence until that lands.
import { createHash, randomBytes } from 'node:crypto';
import { unitFromDigest } from './fairness';

// The Hi-Lo roller: one per server process, holding the boot secret and each
// account's play nonce. Injected into the dispatch so it unit-tests without the
// GameServer.
export class HiloRoller {
  private readonly secret: Buffer;
  private readonly nonces = new Map<number, number>();

  constructor(secret: Buffer = randomBytes(32)) {
    this.secret = secret;
  }

  /** The next fair 1 to 100 roll for this account + client seed, advancing the
   *  account's nonce. Returns the roll and the nonce it used (for an audit log). */
  roll(accountId: number, clientSeed: string): { roll: number; nonce: number } {
    const nonce = (this.nonces.get(accountId) ?? 0) + 1;
    this.nonces.set(accountId, nonce);
    const digest = createHash('sha256')
      .update(this.secret)
      .update(Buffer.from(`|hilo|${accountId}|${nonce}|${clientSeed}`, 'utf8'))
      .digest();
    const roll = 1 + Math.floor(unitFromDigest(digest) * 100);
    return { roll, nonce };
  }
}
