// AdService — the server-authoritative "which ad is live right now" engine for the
// in-game advertising marketplace. A process-local singleton: each realm process
// runs the identical recompute() tick against the shared DB and broadcasts the
// result to its own WS clients, so all realms converge within one tick. Holds the
// current active-ad-per-placement map in memory so the public /api/ads/active and
// /newspaper reads never hit the DB per request (the map is the 10s-cadence cache).
//
// All DB access goes through ads_db (the server SQL-stays-in-*_db rule). The
// scheduler transitions are idempotent UPDATE … WHERE status = … statements, so
// concurrent ticks across processes are safe (only one wins each row).
import { AD_MARKET_ENABLED } from './woc_config';
import {
  sweepExpiredReservations,
  activateDueBookings,
  expireEndedBookings,
  currentLiveBookings,
  pruneAdQuotes,
  pruneAdvertiserChallenges,
} from './ads_db';

export interface ActiveAd {
  placementId: string;
  kind: 'image' | 'text';
  creativeId: number | null;
  text: string;
  clickUrl: string;
  cta: string; // real-world partner call-to-action ("Get the app", "20% off")
  advertiser: string;
  endSec: number;
}

export type ActiveAdMap = Record<string, ActiveAd[]>;

class AdService {
  private active: ActiveAdMap = {};
  private signature = ''; // cheap change-detection digest of `active`

  /** The current active-ad-per-placement map (in-memory; refreshed each tick). */
  getActive(): ActiveAdMap {
    return this.active;
  }

  /** Active ads for one placement (empty array when nothing is live). */
  getForPlacement(placementId: string): ActiveAd[] {
    return this.active[placementId] ?? [];
  }

  /**
   * Advance booking statuses (reserve sweep, go-live, expire), rebuild the active
   * map, and report whether it changed since last tick. Cheap no-op when the
   * market is disabled. Never throws — a transient DB error leaves the last map
   * in place and is logged.
   */
  async recompute(): Promise<{ changed: boolean; active: ActiveAdMap }> {
    if (!AD_MARKET_ENABLED) {
      const changed = this.signature !== '';
      this.active = {};
      this.signature = '';
      return { changed, active: this.active };
    }
    try {
      await sweepExpiredReservations();
      await activateDueBookings();
      await expireEndedBookings();
      const rows = await currentLiveBookings();
      const next: ActiveAdMap = {};
      for (const r of rows) {
        const ad: ActiveAd = {
          placementId: r.placement_id,
          kind: (r.creative_kind ?? 'text') as 'image' | 'text',
          creativeId: r.creative_id,
          text: r.creative_text,
          clickUrl: r.click_url,
          cta: r.cta,
          advertiser: r.advertiser_name,
          endSec: r.end_sec,
        };
        (next[r.placement_id] ??= []).push(ad);
      }
      const sig = JSON.stringify(next);
      const changed = sig !== this.signature;
      this.active = next;
      this.signature = sig;
      return { changed, active: next };
    } catch (err) {
      console.error('[ads] recompute failed:', err);
      return { changed: false, active: this.active };
    }
  }

  /** Opportunistic housekeeping run on a slower cadence than recompute(). */
  async housekeep(): Promise<void> {
    if (!AD_MARKET_ENABLED) return;
    try {
      await pruneAdQuotes();
      await pruneAdvertiserChallenges();
    } catch (err) {
      console.error('[ads] housekeep failed:', err);
    }
  }
}

// Process-local singleton shared by the GameServer tick (drives recompute +
// broadcast) and the ads.ts HTTP reads (/active, /newspaper).
export const adService = new AdService();
