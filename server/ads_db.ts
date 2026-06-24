// ads_db.ts — all SQL for the in-game advertising marketplace ("The Claudemoon
// Gazette"). Per the server invariant, SQL lives only in db.ts / *_db.ts; the
// logic modules (ads.ts, ad_payment.ts, ad_refund.ts, game.ts AdService) call
// these helpers and carry no raw queries.
//
// The ad domain is GLOBAL (not realm-scoped): a minute sold is the same minute on
// every realm process, all sharing this one database. All slot times are UTC and
// stored as tstzrange. BIGINT money columns are bound as decimal strings because
// base-unit amounts can exceed Number.MAX_SAFE_INTEGER — callers pass bigints.

import type { PoolClient } from 'pg';
import { pool } from './db';
import { isUniqueViolation } from './http_util';
import {
  type AdAsset,
  adDefaultRatePerMinuteBase,
} from './woc_config';

// Postgres exclusion_violation (the ad_bookings_no_overlap EXCLUDE guard fires).
export function isExclusionViolation(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: string }).code === '23P01';
}

// Live-ish booking statuses occupy a slot (must match the EXCLUDE predicate).
const OCCUPYING = "('reserved','paid','pending_review','live')";

// ── Placement seed ───────────────────────────────────────────────────────────
// Idempotent; runs under the schema advisory lock from ensureSchema(). Defines
// the surfaces and gives each a default active rate card (only if none exists).
interface PlacementSeed {
  id: string;
  kind: string;
  displayName: string;
  capacity: number;
  creativeType: 'image' | 'text';
  creativeW: number | null;
  creativeH: number | null;
  worldX: number | null;
  worldZ: number | null;
  worldYaw: number | null;
  sort: number;
}

// Billboards anchor near the Eastbrook town hub (x:0, z:0, radius 26 — see
// src/sim/content/zone1.ts). Coordinates are refined by the renderer in Phase 5.
const PLACEMENT_SEEDS: PlacementSeed[] = [
  { id: 'newspaper-featured', kind: 'newspaper', displayName: 'Gazette — Front Page', capacity: 1, creativeType: 'image', creativeW: 600, creativeH: 400, worldX: null, worldZ: null, worldYaw: null, sort: 0 },
  { id: 'classifieds', kind: 'classifieds', displayName: 'Gazette — Classifieds', capacity: 50, creativeType: 'text', creativeW: null, creativeH: null, worldX: null, worldZ: null, worldYaw: null, sort: 1 },
  { id: 'ticker', kind: 'ticker', displayName: 'Town Crier (HUD ticker)', capacity: 1, creativeType: 'text', creativeW: null, creativeH: null, worldX: null, worldZ: null, worldYaw: null, sort: 2 },
  { id: 'billboard-townsquare', kind: 'billboard', displayName: 'Billboard — Town Square', capacity: 1, creativeType: 'image', creativeW: 512, creativeH: 256, worldX: 8, worldZ: -6, worldYaw: 0, sort: 3 },
  { id: 'billboard-gate', kind: 'billboard', displayName: 'Billboard — South Gate', capacity: 1, creativeType: 'image', creativeW: 512, creativeH: 256, worldX: 0, worldZ: 22, worldYaw: Math.PI, sort: 4 },
  { id: 'billboard-market', kind: 'billboard', displayName: 'Billboard — Market Row', capacity: 1, creativeType: 'image', creativeW: 512, creativeH: 256, worldX: -10, worldZ: 8, worldYaw: 0, sort: 5 },
];

export async function seedAdPlacements(client: PoolClient): Promise<void> {
  for (const p of PLACEMENT_SEEDS) {
    await client.query(
      `INSERT INTO ad_placements
         (id, kind, display_name, capacity, creative_type, creative_w, creative_h, world_x, world_z, world_yaw, sort)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
       ON CONFLICT (id) DO NOTHING`,
      [p.id, p.kind, p.displayName, p.capacity, p.creativeType, p.creativeW, p.creativeH, p.worldX, p.worldZ, p.worldYaw, p.sort],
    );
    // Seed a default active rate card only if the placement has none.
    await client.query(
      `INSERT INTO ad_rate_card (placement_id, price_per_min_usdc, price_per_min_sol, price_per_min_woc)
       SELECT $1, $2, $3, $4
       WHERE NOT EXISTS (SELECT 1 FROM ad_rate_card WHERE placement_id = $1 AND active)`,
      [
        p.id,
        String(adDefaultRatePerMinuteBase('USDC')),
        String(adDefaultRatePerMinuteBase('SOL')),
        String(adDefaultRatePerMinuteBase('WOC')),
      ],
    );
  }
}

// ── Placements + rate card ───────────────────────────────────────────────────
export interface PlacementRow {
  id: string;
  kind: string;
  display_name: string;
  capacity: number;
  creative_type: 'image' | 'text';
  creative_w: number | null;
  creative_h: number | null;
  world_x: number | null;
  world_z: number | null;
  world_yaw: number | null;
  active: boolean;
  sort: number;
}

export interface RateCardRow {
  id: number;
  placement_id: string;
  price_per_min_usdc: string;
  price_per_min_sol: string;
  price_per_min_woc: string;
  min_minutes: number;
  max_minutes: number;
}

export async function listPlacements(): Promise<PlacementRow[]> {
  const res = await pool.query(
    `SELECT id, kind, display_name, capacity, creative_type, creative_w, creative_h,
            world_x, world_z, world_yaw, active, sort
       FROM ad_placements WHERE active ORDER BY sort, id`,
  );
  return res.rows;
}

export async function getPlacement(id: string): Promise<PlacementRow | null> {
  const res = await pool.query(
    `SELECT id, kind, display_name, capacity, creative_type, creative_w, creative_h,
            world_x, world_z, world_yaw, active, sort
       FROM ad_placements WHERE id = $1`,
    [id],
  );
  return res.rows[0] ?? null;
}

export async function getActiveRateCard(placementId: string): Promise<RateCardRow | null> {
  const res = await pool.query(
    `SELECT id, placement_id, price_per_min_usdc, price_per_min_sol, price_per_min_woc, min_minutes, max_minutes
       FROM ad_rate_card WHERE placement_id = $1 AND active
       ORDER BY effective_from DESC LIMIT 1`,
    [placementId],
  );
  return res.rows[0] ?? null;
}

export function ratePerMinuteForAsset(card: RateCardRow, asset: AdAsset): bigint {
  const v = asset === 'USDC' ? card.price_per_min_usdc : asset === 'SOL' ? card.price_per_min_sol : card.price_per_min_woc;
  return BigInt(v);
}

// Set a new active rate card for a placement; deactivate the prior one. Returns
// the new row id. Existing bookings keep their frozen locked_price_base.
export async function setRateCard(row: {
  placementId: string;
  usdcBase: bigint;
  solBase: bigint;
  wocBase: bigint;
  minMinutes: number;
  maxMinutes: number;
}): Promise<number> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('UPDATE ad_rate_card SET active = FALSE WHERE placement_id = $1 AND active', [row.placementId]);
    const res = await client.query(
      `INSERT INTO ad_rate_card (placement_id, price_per_min_usdc, price_per_min_sol, price_per_min_woc, min_minutes, max_minutes)
       VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
      [row.placementId, String(row.usdcBase), String(row.solBase), String(row.wocBase), row.minMinutes, row.maxMinutes],
    );
    await client.query('COMMIT');
    return Number(res.rows[0].id);
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

// ── Advertisers (wallet identity) ────────────────────────────────────────────
export interface AdvertiserRow {
  id: number;
  pubkey: string;
  display_name: string;
  contact: string;
  blocked: boolean;
}

export async function upsertAdvertiser(pubkey: string): Promise<AdvertiserRow> {
  // Solana addresses are base58 and CASE-SENSITIVE — store verbatim. (Lowercasing
  // them, Ethereum-style, corrupts the key and breaks on-chain payer matching.)
  const res = await pool.query(
    `INSERT INTO advertisers (pubkey) VALUES ($1)
     ON CONFLICT (pubkey) DO UPDATE SET pubkey = EXCLUDED.pubkey
     RETURNING id, pubkey, display_name, contact, blocked`,
    [pubkey],
  );
  return res.rows[0];
}

export async function advertiserById(id: number): Promise<AdvertiserRow | null> {
  const res = await pool.query(
    `SELECT id, pubkey, display_name, contact, blocked FROM advertisers WHERE id = $1`,
    [id],
  );
  return res.rows[0] ?? null;
}

export async function setAdvertiserBlocked(id: number, blocked: boolean): Promise<void> {
  await pool.query('UPDATE advertisers SET blocked = $2 WHERE id = $1', [id, blocked]);
}

export async function setAdvertiserProfile(id: number, displayName: string, contact: string): Promise<void> {
  await pool.query('UPDATE advertisers SET display_name = $2, contact = $3 WHERE id = $1', [id, displayName, contact]);
}

// ── Advertiser sign-in challenges + bearer tokens ────────────────────────────
export async function createAdvertiserChallenge(nonce: string, pubkey: string, message: string, ttlMinutes: number): Promise<void> {
  await pool.query(
    `INSERT INTO advertiser_challenges (nonce, pubkey, message, expires_at)
     VALUES ($1, $2, $3, now() + ($4 || ' minutes')::interval)`,
    [nonce, pubkey, message, String(ttlMinutes)],
  );
}

// Consume (delete) a challenge, returning its stored message/pubkey if valid.
export async function consumeAdvertiserChallenge(nonce: string): Promise<{ pubkey: string; message: string } | null> {
  const res = await pool.query(
    `DELETE FROM advertiser_challenges WHERE nonce = $1 AND expires_at > now()
     RETURNING pubkey, message`,
    [nonce],
  );
  return res.rows[0] ?? null;
}

export async function pruneAdvertiserChallenges(): Promise<void> {
  await pool.query('DELETE FROM advertiser_challenges WHERE expires_at <= now()');
}

export async function saveAdvertiserToken(token: string, advertiserId: number, ttlDays: number): Promise<void> {
  await pool.query(
    `INSERT INTO advertiser_tokens (token, advertiser_id, expires_at)
     VALUES ($1, $2, now() + ($3 || ' days')::interval)`,
    [token, advertiserId, String(ttlDays)],
  );
}

export async function advertiserForToken(token: string): Promise<number | null> {
  const res = await pool.query(
    `SELECT advertiser_id FROM advertiser_tokens WHERE token = $1 AND expires_at > now()`,
    [token],
  );
  return res.rows[0]?.advertiser_id ?? null;
}

// ── Creatives ────────────────────────────────────────────────────────────────
export interface CreativeRow {
  id: number;
  advertiser_id: number;
  kind: 'image' | 'text';
  creative_text: string;
  click_url: string;
  cta: string;
  width: number | null;
  height: number | null;
  review_status: 'pending' | 'approved' | 'rejected';
  review_note: string;
  created_at: string;
}

export async function insertImageCreative(row: {
  advertiserId: number;
  png: Buffer;
  width: number;
  height: number;
  clickUrl: string;
  cta: string;
}): Promise<number> {
  const res = await pool.query(
    `INSERT INTO ad_creatives (advertiser_id, kind, png, width, height, click_url, cta)
     VALUES ($1, 'image', $2, $3, $4, $5, $6) RETURNING id`,
    [row.advertiserId, row.png, row.width, row.height, row.clickUrl, row.cta],
  );
  return Number(res.rows[0].id);
}

export async function insertTextCreative(row: {
  advertiserId: number;
  text: string;
  clickUrl: string;
  cta: string;
}): Promise<number> {
  const res = await pool.query(
    `INSERT INTO ad_creatives (advertiser_id, kind, creative_text, click_url, cta)
     VALUES ($1, 'text', $2, $3, $4) RETURNING id`,
    [row.advertiserId, row.text, row.clickUrl, row.cta],
  );
  return Number(res.rows[0].id);
}

export async function getCreative(id: number): Promise<CreativeRow | null> {
  const res = await pool.query(
    `SELECT id, advertiser_id, kind, creative_text, click_url, cta, width, height, review_status, review_note, created_at
       FROM ad_creatives WHERE id = $1`,
    [id],
  );
  return res.rows[0] ?? null;
}

// The PNG bytes for a creative. `onlyApproved` gates the public route so unapproved
// art is never served to players; admins read with onlyApproved = false.
export async function getCreativePng(id: number, onlyApproved: boolean): Promise<Buffer | null> {
  const res = await pool.query(
    `SELECT png FROM ad_creatives WHERE id = $1 AND kind = 'image'${onlyApproved ? " AND review_status = 'approved'" : ''}`,
    [id],
  );
  const png = res.rows[0]?.png;
  return png ? Buffer.from(png) : null;
}

export async function setCreativeReview(id: number, status: 'approved' | 'rejected', note: string, reviewerAccountId: number): Promise<void> {
  await pool.query(
    `UPDATE ad_creatives SET review_status = $2, review_note = $3, reviewed_by = $4, reviewed_at = now() WHERE id = $1`,
    [id, status, note, reviewerAccountId],
  );
}

// ── Availability + reservations ──────────────────────────────────────────────
export interface BusyRange {
  start: number; // epoch seconds
  end: number;
  lane: number;
}

// Booked (occupying) ranges for a placement intersecting [dayStart, dayEnd) UTC.
export async function busyRangesForDay(placementId: string, dayStartSec: number, dayEndSec: number): Promise<BusyRange[]> {
  const res = await pool.query(
    `SELECT extract(epoch FROM lower(slot))::bigint AS start,
            extract(epoch FROM upper(slot))::bigint AS end, lane
       FROM ad_bookings
      WHERE placement_id = $1 AND status IN ${OCCUPYING}
        AND slot && tstzrange(to_timestamp($2), to_timestamp($3), '[)')
      ORDER BY lower(slot)`,
    [placementId, dayStartSec, dayEndSec],
  );
  return res.rows.map((r) => ({ start: Number(r.start), end: Number(r.end), lane: r.lane }));
}

export interface ReserveResult {
  ok: boolean;
  reason?: 'slot_taken' | 'capacity_full';
  bookingId?: number;
  lane?: number;
}

// Reserve a slot: pick the lowest free lane for the requested window, then INSERT
// the booking as 'reserved'. The ad_bookings_no_overlap EXCLUDE constraint is the
// final, race-free authority — a concurrent insert that grabbed the same lane
// fails 23P01 and we surface 'slot_taken'.
export async function reserveBooking(row: {
  placementId: string;
  advertiserId: number;
  creativeId: number | null;
  asset: AdAsset;
  startSec: number;
  endSec: number;
  capacity: number;
  lockedPriceBase: bigint;
  rateCardId: number;
  reserveTtlMinutes: number;
}): Promise<ReserveResult> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const lane = await client.query(
      `WITH lanes AS (SELECT generate_series(0, $2 - 1) AS lane),
            busy AS (
              SELECT DISTINCT lane FROM ad_bookings
               WHERE placement_id = $1 AND status IN ${OCCUPYING}
                 AND slot && tstzrange(to_timestamp($3), to_timestamp($4), '[)')
            )
       SELECT lane FROM lanes WHERE lane NOT IN (SELECT lane FROM busy) ORDER BY lane LIMIT 1`,
      [row.placementId, row.capacity, row.startSec, row.endSec],
    );
    if (lane.rows.length === 0) {
      await client.query('ROLLBACK');
      return { ok: false, reason: 'capacity_full' };
    }
    const chosenLane = lane.rows[0].lane as number;
    const ins = await client.query(
      `INSERT INTO ad_bookings
         (placement_id, advertiser_id, creative_id, slot, lane, asset, status, locked_price_base, rate_card_id, reserve_expires_at)
       VALUES ($1, $2, $3, tstzrange(to_timestamp($4), to_timestamp($5), '[)'), $6, $7, 'reserved', $8, $9,
               now() + ($10 || ' minutes')::interval)
       RETURNING id`,
      [row.placementId, row.advertiserId, row.creativeId, row.startSec, row.endSec, chosenLane, row.asset, String(row.lockedPriceBase), row.rateCardId, String(row.reserveTtlMinutes)],
    );
    await client.query('COMMIT');
    return { ok: true, bookingId: Number(ins.rows[0].id), lane: chosenLane };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    if (isExclusionViolation(err)) return { ok: false, reason: 'slot_taken' };
    throw err;
  } finally {
    client.release();
  }
}

export interface BookingRow {
  id: number;
  placement_id: string;
  advertiser_id: number;
  creative_id: number | null;
  asset: AdAsset;
  status: string;
  locked_price_base: string;
  ad_payment_id: string | null;
  payment_ref: string | null;
  start_sec: number;
  end_sec: number;
}

export async function getBooking(id: number): Promise<BookingRow | null> {
  const res = await pool.query(
    `SELECT id, placement_id, advertiser_id, creative_id, asset, status, locked_price_base,
            ad_payment_id, payment_ref,
            extract(epoch FROM lower(slot))::bigint AS start_sec,
            extract(epoch FROM upper(slot))::bigint AS end_sec
       FROM ad_bookings WHERE id = $1`,
    [id],
  );
  const r = res.rows[0];
  if (!r) return null;
  return { ...r, start_sec: Number(r.start_sec), end_sec: Number(r.end_sec) };
}

// Bind a creative to a reserved booking (the buyer may upload after reserving).
export async function setBookingCreative(bookingId: number, advertiserId: number, creativeId: number): Promise<boolean> {
  const res = await pool.query(
    `UPDATE ad_bookings SET creative_id = $3, updated_at = now()
       WHERE id = $1 AND advertiser_id = $2 AND status = 'reserved'`,
    [bookingId, advertiserId, creativeId],
  );
  return (res.rowCount ?? 0) > 0;
}

export async function listAdvertiserBookings(advertiserId: number): Promise<Array<BookingRow & { review_status: string | null }>> {
  const res = await pool.query(
    `SELECT b.id, b.placement_id, b.advertiser_id, b.creative_id, b.asset, b.status, b.locked_price_base,
            b.ad_payment_id, b.payment_ref,
            extract(epoch FROM lower(b.slot))::bigint AS start_sec,
            extract(epoch FROM upper(b.slot))::bigint AS end_sec,
            c.review_status
       FROM ad_bookings b LEFT JOIN ad_creatives c ON c.id = b.creative_id
      WHERE b.advertiser_id = $1
      ORDER BY lower(b.slot) DESC LIMIT 200`,
    [advertiserId],
  );
  return res.rows.map((r) => ({ ...r, start_sec: Number(r.start_sec), end_sec: Number(r.end_sec) }));
}

// ── Quotes (price lock) ──────────────────────────────────────────────────────
export interface AdQuoteRow {
  quote_id: string;
  advertiser_id: number;
  booking_id: string;
  asset: AdAsset;
  price_base: string;
  payer_pubkey: string;
  payload: any;
}

export async function createAdQuote(row: {
  quoteId: string;
  advertiserId: number;
  bookingId: number;
  asset: AdAsset;
  priceBase: bigint;
  payerPubkey: string;
  payload: unknown;
  ttlMinutes: number;
}): Promise<void> {
  await pool.query(
    `INSERT INTO ad_quotes (quote_id, advertiser_id, booking_id, asset, price_base, payer_pubkey, payload, expires_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7, now() + ($8 || ' minutes')::interval)`,
    [row.quoteId, row.advertiserId, row.bookingId, row.asset, String(row.priceBase), row.payerPubkey, JSON.stringify(row.payload ?? {}), String(row.ttlMinutes)],
  );
}

export async function getAdQuote(quoteId: string, advertiserId: number): Promise<AdQuoteRow | null> {
  const res = await pool.query(
    `SELECT quote_id, advertiser_id, booking_id, asset, price_base, payer_pubkey, payload
       FROM ad_quotes WHERE quote_id = $1 AND advertiser_id = $2 AND expires_at > now()`,
    [quoteId, advertiserId],
  );
  return res.rows[0] ?? null;
}

export async function deleteAdQuote(quoteId: string): Promise<void> {
  await pool.query('DELETE FROM ad_quotes WHERE quote_id = $1', [quoteId]);
}

export async function pruneAdQuotes(): Promise<void> {
  await pool.query('DELETE FROM ad_quotes WHERE expires_at <= now()');
}

// ── Payments + booking settlement ────────────────────────────────────────────
// Record a consumed on-chain ad payment. Returns null when tx_sig was already
// recorded (UNIQUE replay guard) so the caller rejects the double-spend.
export async function recordAdPayment(row: {
  advertiserId: number;
  bookingId: number;
  asset: AdAsset;
  txSig: string;
  mint: string | null;
  amountBase: bigint;
  treasuryBase: bigint;
  payerPubkey: string;
  reference: string;
}): Promise<{ id: number } | null> {
  try {
    const res = await pool.query(
      `INSERT INTO ad_payments (advertiser_id, booking_id, asset, tx_sig, mint, amount_base, treasury_base, payer_pubkey, reference)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`,
      [row.advertiserId, row.bookingId, row.asset, row.txSig, row.mint, String(row.amountBase), String(row.treasuryBase), row.payerPubkey, row.reference],
    );
    return { id: Number(res.rows[0].id) };
  } catch (err) {
    if (isUniqueViolation(err)) return null;
    throw err;
  }
}

// Advance a reserved booking to pending_review once its payment is recorded.
export async function markBookingPaid(bookingId: number, adPaymentId: number, paymentRef: string): Promise<boolean> {
  const res = await pool.query(
    `UPDATE ad_bookings SET status = 'pending_review', ad_payment_id = $2, payment_ref = $3, updated_at = now()
       WHERE id = $1 AND status IN ('reserved','paid')`,
    [bookingId, adPaymentId, paymentRef],
  );
  return (res.rowCount ?? 0) > 0;
}

export interface AdPaymentRow {
  id: number;
  asset: AdAsset;
  treasury_base: string;
  burned_base: string;
  payer_pubkey: string;
  mint: string | null;
}

export async function getAdPaymentForBooking(bookingId: number): Promise<AdPaymentRow | null> {
  const res = await pool.query(
    `SELECT p.id, p.asset, p.treasury_base, p.burned_base, p.payer_pubkey, p.mint
       FROM ad_payments p JOIN ad_bookings b ON b.ad_payment_id = p.id WHERE b.id = $1`,
    [bookingId],
  );
  return res.rows[0] ?? null;
}

export async function setBookingState(bookingId: number, status: string): Promise<void> {
  await pool.query('UPDATE ad_bookings SET status = $2, updated_at = now() WHERE id = $1', [bookingId, status]);
}

// Atomically claim a WOC booking for its post-approval deferred burn (sets a
// 'pending' sentinel on burn_sig). Only one caller wins, preventing a double burn
// on a double-approval. Returns the payment id, or null if already claimed/burned
// or not a WOC booking.
export async function claimAdBurn(bookingId: number): Promise<{ adPaymentId: number } | null> {
  const res = await pool.query(
    `UPDATE ad_bookings SET burn_sig = 'pending', updated_at = now()
       WHERE id = $1 AND burn_sig IS NULL AND asset = 'WOC' AND ad_payment_id IS NOT NULL
       RETURNING ad_payment_id`,
    [bookingId],
  );
  const r = res.rows[0];
  return r ? { adPaymentId: Number(r.ad_payment_id) } : null;
}

// Release a burn claim after a failed burn so it can be retried.
export async function revertAdBurnClaim(bookingId: number): Promise<void> {
  await pool.query(`UPDATE ad_bookings SET burn_sig = NULL WHERE id = $1 AND burn_sig = 'pending'`, [bookingId]);
}

// Record a deferred $WOC burn signature against a booking + its payment (overwrites
// the 'pending' sentinel set by claimAdBurn).
export async function recordDeferredBurn(bookingId: number, adPaymentId: number, burnSig: string, burnedBase: bigint): Promise<void> {
  await pool.query('UPDATE ad_bookings SET burn_sig = $2, updated_at = now() WHERE id = $1', [bookingId, burnSig]);
  await pool.query('UPDATE ad_payments SET burned_base = $2 WHERE id = $1', [adPaymentId, String(burnedBase)]);
}

// ── Refund CAS lock + ledger ─────────────────────────────────────────────────
// Atomically claim a booking for refund (cross-process lock). Only one process
// can move a booking out of a refundable status into 'refund_pending'; it returns
// the payment id to refund, or null when not refundable (already claimed/refunded,
// or no recorded payment). The guard requires ad_payment_id IS NOT NULL so a
// paymentless row is never flipped. On refund failure the caller reverts to the
// safe 'pending_review' status (see revertRefundPending).
export async function markRefundPending(bookingId: number): Promise<{ adPaymentId: number } | null> {
  const res = await pool.query(
    `UPDATE ad_bookings SET status = 'refund_pending', updated_at = now()
       WHERE id = $1 AND ad_payment_id IS NOT NULL
         AND status IN ('paid','pending_review','live','rejected','refund_failed')
       RETURNING ad_payment_id`,
    [bookingId],
  );
  const r = res.rows[0];
  if (!r) return null;
  return { adPaymentId: Number(r.ad_payment_id) };
}

export async function revertRefundPending(bookingId: number, toStatus: string): Promise<void> {
  await pool.query(
    `UPDATE ad_bookings SET status = $2, updated_at = now() WHERE id = $1 AND status = 'refund_pending'`,
    [bookingId, toStatus],
  );
}

export async function recordAdRefund(row: {
  bookingId: number;
  adPaymentId: number;
  asset: AdAsset;
  amountBase: bigint;
  refundSig: string;
  payerPubkey: string;
}): Promise<{ id: number } | null> {
  try {
    const res = await pool.query(
      `INSERT INTO ad_refunds (booking_id, ad_payment_id, asset, amount_base, refund_sig, payer_pubkey)
       VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
      [row.bookingId, row.adPaymentId, row.asset, String(row.amountBase), row.refundSig, row.payerPubkey],
    );
    return { id: Number(res.rows[0].id) };
  } catch (err) {
    if (isUniqueViolation(err)) return null;
    throw err;
  }
}

export async function setBookingRefunded(bookingId: number, refundSig: string): Promise<void> {
  await pool.query(
    `UPDATE ad_bookings SET status = 'refunded', refund_sig = $2, updated_at = now() WHERE id = $1`,
    [bookingId, refundSig],
  );
}

export async function existingRefundSig(bookingId: number): Promise<string | null> {
  const res = await pool.query('SELECT refund_sig FROM ad_refunds WHERE booking_id = $1', [bookingId]);
  return res.rows[0]?.refund_sig ?? null;
}

// ── Scheduler (per-process 10s tick; idempotent across realm processes) ───────
export async function sweepExpiredReservations(): Promise<void> {
  await pool.query(
    `UPDATE ad_bookings SET status = 'cancelled', updated_at = now()
       WHERE status = 'reserved' AND reserve_expires_at IS NOT NULL AND reserve_expires_at < now()`,
  );
}

// Activate bookings whose window is open AND whose creative is approved.
export async function activateDueBookings(): Promise<void> {
  await pool.query(
    `UPDATE ad_bookings b SET status = 'live', updated_at = now()
       FROM ad_creatives c
      WHERE b.creative_id = c.id AND c.review_status = 'approved'
        AND b.status = 'pending_review'
        AND lower(b.slot) <= now() AND upper(b.slot) > now()`,
  );
}

export async function expireEndedBookings(): Promise<void> {
  await pool.query(
    `UPDATE ad_bookings SET status = 'expired', updated_at = now()
       WHERE status = 'live' AND upper(slot) <= now()`,
  );
}

export interface ActiveBookingRow {
  placement_id: string;
  kind: string;
  lane: number;
  creative_id: number | null;
  creative_kind: 'image' | 'text' | null;
  creative_text: string;
  click_url: string;
  cta: string;
  advertiser_name: string;
  end_sec: number;
}

// All currently-live bookings joined with their creative + placement. Drives the
// server-authoritative activeAds map (billboards / ticker / newspaper featured).
export async function currentLiveBookings(): Promise<ActiveBookingRow[]> {
  const res = await pool.query(
    `SELECT b.placement_id, p.kind, b.lane, b.creative_id,
            c.kind AS creative_kind, COALESCE(c.creative_text, '') AS creative_text,
            COALESCE(c.click_url, '') AS click_url, COALESCE(c.cta, '') AS cta,
            COALESCE(NULLIF(a.display_name, ''), '') AS advertiser_name,
            extract(epoch FROM upper(b.slot))::bigint AS end_sec
       FROM ad_bookings b
       JOIN ad_placements p ON p.id = b.placement_id
       LEFT JOIN ad_creatives c ON c.id = b.creative_id
       LEFT JOIN advertisers a ON a.id = b.advertiser_id
      WHERE b.status = 'live' AND now() >= lower(b.slot) AND now() < upper(b.slot)
      ORDER BY b.placement_id, b.lane`,
  );
  return res.rows.map((r) => ({ ...r, end_sec: Number(r.end_sec) }));
}

// ── Admin CRM queries ────────────────────────────────────────────────────────
export interface ReviewRow {
  id: number;
  advertiser_id: number;
  advertiser_pubkey: string;
  advertiser_name: string;
  kind: 'image' | 'text';
  creative_text: string;
  cta: string;
  click_url: string;
  width: number | null;
  height: number | null;
  created_at: string;
  booking_count: number;
}

// Creatives awaiting review (oldest first), with how many bookings ride on each.
export async function listReviewQueue(): Promise<ReviewRow[]> {
  const res = await pool.query(
    `SELECT c.id, c.advertiser_id, a.pubkey AS advertiser_pubkey,
            COALESCE(NULLIF(a.display_name,''),'') AS advertiser_name,
            c.kind, c.creative_text, c.cta, c.click_url, c.width, c.height, c.created_at,
            (SELECT count(*)::int FROM ad_bookings b WHERE b.creative_id = c.id) AS booking_count
       FROM ad_creatives c JOIN advertisers a ON a.id = c.advertiser_id
      WHERE c.review_status = 'pending'
      ORDER BY c.created_at ASC LIMIT 200`,
  );
  return res.rows;
}

// Bookings backed by a creative (for the approve→burn / reject→refund fan-out).
export async function bookingsForCreative(creativeId: number): Promise<Array<{ id: number; status: string; asset: AdAsset }>> {
  const res = await pool.query(
    `SELECT id, status, asset FROM ad_bookings WHERE creative_id = $1`,
    [creativeId],
  );
  return res.rows;
}

export interface AdminBookingRow {
  id: number;
  placement_id: string;
  advertiser_pubkey: string;
  advertiser_name: string;
  asset: AdAsset;
  status: string;
  review_status: string | null;
  locked_price_base: string;
  start_sec: number;
  end_sec: number;
}

export async function adminListBookings(opts: { status?: string; limit: number }): Promise<AdminBookingRow[]> {
  const params: any[] = [opts.limit];
  let where = '';
  if (opts.status) {
    params.push(opts.status);
    where = `WHERE b.status = $${params.length}`;
  }
  const res = await pool.query(
    `SELECT b.id, b.placement_id, a.pubkey AS advertiser_pubkey,
            COALESCE(NULLIF(a.display_name,''),'') AS advertiser_name,
            b.asset, b.status, c.review_status, b.locked_price_base,
            extract(epoch FROM lower(b.slot))::bigint AS start_sec,
            extract(epoch FROM upper(b.slot))::bigint AS end_sec
       FROM ad_bookings b
       JOIN advertisers a ON a.id = b.advertiser_id
       LEFT JOIN ad_creatives c ON c.id = b.creative_id
       ${where}
      ORDER BY lower(b.slot) DESC LIMIT $1`,
    params,
  );
  return res.rows.map((r) => ({ ...r, start_sec: Number(r.start_sec), end_sec: Number(r.end_sec) }));
}

// Collected revenue per asset (bookings that ran / will run) and refunded totals.
export interface RevenueRow { asset: AdAsset; collected_base: string; bookings: number; refunded_base: string }
export async function adRevenue(): Promise<RevenueRow[]> {
  const res = await pool.query(
    `SELECT b.asset,
            COALESCE(sum(b.locked_price_base) FILTER (WHERE b.status IN ('paid','pending_review','live','expired')), 0)::text AS collected_base,
            count(*) FILTER (WHERE b.status IN ('paid','pending_review','live','expired'))::int AS bookings,
            COALESCE((SELECT sum(r.amount_base) FROM ad_refunds r WHERE r.asset = b.asset), 0)::text AS refunded_base
       FROM ad_bookings b
      GROUP BY b.asset`,
  );
  return res.rows;
}
