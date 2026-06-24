// Client for the public + advertiser ad-marketplace endpoints (The Claudemoon
// Gazette). Separate from the realm-scoped game `Api` (online.ts): ad endpoints
// are global and reachable from the page origin, and advertiser auth is wallet-
// based (a short-lived bearer token held in memory, never localStorage).
import type { AdAssetClient } from '../world_api';

export interface RateCardClient {
  usdcPerMinBase: string;
  solPerMinBase: string;
  wocPerMinBase: string;
  minMinutes: number;
  maxMinutes: number;
}
export interface PlacementClient {
  id: string;
  kind: string;
  displayName: string;
  capacity: number;
  creativeType: 'image' | 'text';
  creativeW: number | null;
  creativeH: number | null;
  rateCard: RateCardClient | null;
}
export interface BusyRangeClient { start: number; end: number; lane: number }
export interface AvailabilityClient { placement: string; day: string; capacity: number; dayStartSec: number; dayEndSec: number; busy: BusyRangeClient[] }
export interface AdQuoteClient {
  quoteId: string;
  memo: string;
  asset: AdAssetClient;
  mint: string | null;
  decimals: number;
  amountBase: string;
  treasury: string;
  payer: string;
  expiresAt: number;
}
export interface BookingClient {
  id: number;
  placement: string;
  asset: AdAssetClient;
  status: string;
  reviewStatus: string | null;
  lockedPriceBase: string;
  startSec: number;
  endSec: number;
}

class AdsApi {
  private token: string | null = null;
  advertiserId: number | null = null;
  pubkey: string | null = null;

  isAuthed(): boolean {
    return this.token !== null;
  }
  signOut(): void {
    this.token = null;
    this.advertiserId = null;
    this.pubkey = null;
  }

  private headers(json = true): Record<string, string> {
    const h: Record<string, string> = {};
    if (json) h['Content-Type'] = 'application/json';
    if (this.token) h.Authorization = `Bearer ${this.token}`;
    return h;
  }

  private async req(path: string, init?: RequestInit): Promise<any> {
    const res = await fetch(path, init);
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error ?? `request failed (${res.status})`);
    return data;
  }

  // ── public reads ──
  placements(): Promise<{ placements: PlacementClient[] }> {
    return this.req('/api/ads/placements');
  }
  availability(placement: string, day: string): Promise<AvailabilityClient> {
    return this.req(`/api/ads/availability?placement=${encodeURIComponent(placement)}&day=${encodeURIComponent(day)}`);
  }

  // ── wallet sign-in ──
  challenge(pubkey: string): Promise<{ nonce: string; message: string }> {
    return this.req('/api/ads/advertiser/challenge', { method: 'POST', headers: this.headers(), body: JSON.stringify({ pubkey }) });
  }
  async auth(pubkey: string, signature: string, nonce: string): Promise<void> {
    const d = await this.req('/api/ads/advertiser/auth', { method: 'POST', headers: this.headers(), body: JSON.stringify({ pubkey, signature, nonce }) });
    this.token = d.token;
    this.advertiserId = d.advertiserId;
    this.pubkey = d.pubkey;
  }

  // ── authed advertiser ──
  uploadTextCreative(text: string, clickUrl: string, cta: string): Promise<{ creativeId: number }> {
    return this.req('/api/ads/creative', { method: 'POST', headers: this.headers(), body: JSON.stringify({ text, clickUrl, cta }) });
  }
  async uploadImageCreative(png: Blob, clickUrl: string, cta: string): Promise<{ creativeId: number; width: number; height: number }> {
    const qs = new URLSearchParams();
    if (clickUrl) qs.set('clickUrl', clickUrl);
    if (cta) qs.set('cta', cta);
    return this.req(`/api/ads/creative?${qs.toString()}`, { method: 'POST', headers: this.headers(false), body: png });
  }
  reserve(body: { placement: string; asset: AdAssetClient; startsAt: number; minutes: number; creativeId: number | null }): Promise<{ bookingId: number; lockedPriceBase: string; minutes: number }> {
    return this.req('/api/ads/reserve', { method: 'POST', headers: this.headers(), body: JSON.stringify(body) });
  }
  quote(bookingId: number): Promise<AdQuoteClient> {
    return this.req('/api/ads/quote', { method: 'POST', headers: this.headers(), body: JSON.stringify({ bookingId }) });
  }
  confirm(quoteId: string, signature: string): Promise<{ ok: boolean; bookingId: number; status: string }> {
    return this.req('/api/ads/confirm', { method: 'POST', headers: this.headers(), body: JSON.stringify({ quoteId, signature }) });
  }
  myBookings(): Promise<{ bookings: BookingClient[] }> {
    return this.req('/api/ads/advertiser/bookings', { headers: this.headers(false) });
  }
}

export const adsApi = new AdsApi();

// Dev-only debug handle (stripped from production builds) — lets local tooling
// inspect/seed the advertiser session, e.g. to demo the authed buyer panel.
if (import.meta.env.DEV) (globalThis as Record<string, unknown>).__adsApi = adsApi;
