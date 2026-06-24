// HTTP surface for the in-game advertising marketplace ("The Claudemoon Gazette").
//
//   PUBLIC (display, always on — show house ads / lore fallback when nothing booked):
//     GET  /api/ads/placements                  surfaces + their active rate card
//     GET  /api/ads/availability?placement&day  busy minute ranges for a UTC day
//     GET  /api/ads/active                       current live ad per placement
//     GET  /api/ads/newspaper                    featured ad + classifieds for the Gazette
//     GET  /ads/creative/<id>.png                an APPROVED image creative
//
//   COMMERCE (advertiser wallet-auth; gated behind AD_MARKET_ENABLED):
//     POST /api/ads/advertiser/challenge { pubkey }              → { nonce, message }
//     POST /api/ads/advertiser/auth { pubkey, signature, nonce } → { token, advertiserId }
//     POST /api/ads/creative   (PNG bytes | JSON {text,clickUrl})→ { creativeId }
//     POST /api/ads/reserve { placement, asset, startsAt, minutes, creativeId } → { bookingId, lockedPriceBase }
//     POST /api/ads/quote { bookingId }          → { quoteId, memo, mint, amountBase, treasury, ... }
//     POST /api/ads/confirm { quoteId, signature}→ verify + settle → { ok, bookingId }
//     GET  /api/ads/advertiser/bookings          the caller's bookings
//
// Mirrors server/identity.ts (quote→confirm) and server/wallet.ts (challenge→sign).
// Advertiser identity is wallet-based (no game account). SQL stays in ads_db.ts.
import type http from 'node:http';
import { randomBytes } from 'node:crypto';
import { json, readBody, readBinaryBody, isPng } from './http_util';
import { newToken } from './auth';
import { findHardWord } from './chat_filter';
import { loadChatFilterState } from './chat_filter_db';
import { isSolanaAddress, verifySolanaSignature } from './wallet_link';
import { verifyAdPayment } from './ad_payment';
import { adService } from './ad_service';
import {
  AD_MARKET_ENABLED,
  AD_MIN_LEAD_MINUTES,
  AD_MAX_MINUTES,
  AD_QUOTE_TTL_MINUTES,
  AD_RESERVE_TTL_MINUTES,
  isAdAsset,
  adMint,
  adDecimals,
  adTreasury,
  type AdAsset,
} from './woc_config';
import {
  listPlacements,
  getPlacement,
  getActiveRateCard,
  ratePerMinuteForAsset,
  busyRangesForDay,
  upsertAdvertiser,
  advertiserById,
  advertiserForToken,
  saveAdvertiserToken,
  createAdvertiserChallenge,
  consumeAdvertiserChallenge,
  insertImageCreative,
  insertTextCreative,
  getCreative,
  getCreativePng,
  reserveBooking,
  getBooking,
  listAdvertiserBookings,
  createAdQuote,
  getAdQuote,
  deleteAdQuote,
  recordAdPayment,
  markBookingPaid,
} from './ads_db';

const MAX_CREATIVE_BYTES = 4 * 1024 * 1024; // 4 MB, like player-card uploads
const ADVERTISER_TOKEN_TTL_DAYS = 7;
const CHALLENGE_TTL_MINUTES = 10;
const MAX_TEXT_LEN = 280;

function requestOrigin(req: http.IncomingMessage): string {
  const fwd = String(req.headers['x-forwarded-proto'] ?? '').split(',')[0].trim();
  const proto = fwd || ((req.socket as { encrypted?: boolean }).encrypted ? 'https' : 'http');
  const host = req.headers.host ?? 'localhost';
  return `${proto}://${host}`;
}

// The advertiser sign-in message stored server-side so the wallet cannot choose
// what it signs (mirrors server/wallet_link.buildLinkMessage).
function buildAdvertiserMessage(domain: string, pubkey: string, nonce: string): string {
  return [
    `${domain} — advertiser sign-in for The Claudemoon Gazette.`,
    `Wallet: ${pubkey}`,
    `Nonce: ${nonce}`,
    'Signing is free, proves you control this wallet, and authorizes no transaction.',
  ].join('\n');
}

// Resolve the advertiser behind a Bearer token; null (and no response written) if
// missing/invalid/blocked — callers send 401 themselves.
async function advertiserFor(req: http.IncomingMessage): Promise<{ id: number; pubkey: string } | null> {
  const m = /^Bearer ([a-f0-9]{64})$/.exec(req.headers.authorization ?? '');
  if (!m) return null;
  const id = await advertiserForToken(m[1]);
  if (id === null) return null;
  const row = await advertiserById(id);
  if (!row || row.blocked) return null;
  return { id: row.id, pubkey: row.pubkey };
}

function validClickUrl(v: unknown): string {
  if (typeof v !== 'string' || v === '') return '';
  try {
    const u = new URL(v);
    return u.protocol === 'https:' || u.protocol === 'http:' ? u.toString() : '';
  } catch {
    return '';
  }
}

// Cached hard-word list (5-min TTL) for screening advertiser-supplied text. Hard
// hits are rejected at submit; everything still passes admin review too.
let _hardWords: string[] = [];
let _hardWordsAt = 0;
async function hardWords(): Promise<string[]> {
  const now = Date.now();
  if (now - _hardWordsAt > 5 * 60_000) {
    try {
      _hardWords = (await loadChatFilterState()).hard;
      _hardWordsAt = now;
    } catch {
      /* keep the last known list on a transient DB error */
    }
  }
  return _hardWords;
}

// Short, single-line call-to-action for real-world partner ads ("Get the app",
// "20% off — code WOC20"). Rendered escaped on the client; capped + control-stripped.
function cleanCta(v: unknown): string {
  if (typeof v !== 'string') return '';
  const s = v.trim().slice(0, 40);
  return [...s].some((ch) => ch.charCodeAt(0) < 0x20 || ch.charCodeAt(0) === 0x7f) ? '' : s;
}

// PNG IHDR width/height (big-endian uint32 at byte offsets 16 and 20).
function pngDimensions(buf: Buffer): { width: number; height: number } | null {
  if (buf.length < 24) return null;
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}

// Public image route: GET /ads/creative/<id>.png — only ever serves APPROVED art.
export async function handleAdCreativeImage(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  try {
    const path = (req.url ?? '').split('?')[0];
    const m = /^\/ads\/creative\/(\d+)\.png$/.exec(path);
    if (!m) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('not found');
      return;
    }
    const png = await getCreativePng(Number(m[1]), true);
    if (!png) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('not found');
      return;
    }
    res.writeHead(200, { 'Content-Type': 'image/png', 'Content-Length': png.length, 'Cache-Control': 'public, max-age=300' });
    res.end(png);
  } catch (err) {
    console.error('ad creative image route error:', err);
    res.writeHead(500, { 'Content-Type': 'text/plain' });
    res.end('internal error');
  }
}

// /api/ads/* dispatcher.
export async function handleAdsApi(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  try {
    const u = new URL(req.url ?? '/', 'http://localhost');
    const path = u.pathname;
    const method = req.method ?? 'GET';

    // ── Public display reads (work even when the market is disabled) ──
    if (method === 'GET' && path === '/api/ads/placements') return await getPlacements(res);
    if (method === 'GET' && path === '/api/ads/availability') return await getAvailability(res, u);
    if (method === 'GET' && path === '/api/ads/active') return json(res, 200, { active: adService.getActive() });
    if (method === 'GET' && path === '/api/ads/newspaper') return getNewspaper(res);

    // ── Advertiser sign-in (challenge/auth) — needs the market enabled ──
    if (method === 'POST' && path === '/api/ads/advertiser/challenge') return await postChallenge(req, res);
    if (method === 'POST' && path === '/api/ads/advertiser/auth') return await postAuth(req, res);

    // ── Authed advertiser endpoints ──
    if (path.startsWith('/api/ads/')) {
      if (!AD_MARKET_ENABLED) return json(res, 503, { error: 'the ad marketplace is not enabled' });
      const adv = await advertiserFor(req);
      if (!adv) return json(res, 401, { error: 'advertiser authentication required' });
      if (method === 'POST' && path === '/api/ads/creative') return await postCreative(req, res, adv, u);
      if (method === 'POST' && path === '/api/ads/reserve') return await postReserve(req, res, adv);
      if (method === 'POST' && path === '/api/ads/quote') return await postQuote(req, res, adv);
      if (method === 'POST' && path === '/api/ads/confirm') return await postConfirm(req, res, adv);
      if (method === 'GET' && path === '/api/ads/advertiser/bookings') return await getBookings(res, adv);
    }
    return json(res, 404, { error: 'not found' });
  } catch (err) {
    if (err instanceof Error && (err.message === 'body too large' || err.message === 'bad json')) {
      return json(res, 400, { error: err.message });
    }
    console.error('ads api error:', err);
    return json(res, 500, { error: 'internal error' });
  }
}

// ── Public reads ─────────────────────────────────────────────────────────────
async function getPlacements(res: http.ServerResponse): Promise<void> {
  const placements = await listPlacements();
  const out = await Promise.all(
    placements.map(async (p) => {
      const card = await getActiveRateCard(p.id);
      return {
        id: p.id,
        kind: p.kind,
        displayName: p.display_name,
        capacity: p.capacity,
        creativeType: p.creative_type,
        creativeW: p.creative_w,
        creativeH: p.creative_h,
        rateCard: card
          ? {
              usdcPerMinBase: card.price_per_min_usdc,
              solPerMinBase: card.price_per_min_sol,
              wocPerMinBase: card.price_per_min_woc,
              minMinutes: card.min_minutes,
              maxMinutes: card.max_minutes,
            }
          : null,
      };
    }),
  );
  json(res, 200, { placements: out });
}

async function getAvailability(res: http.ServerResponse, u: URL): Promise<void> {
  const placementId = u.searchParams.get('placement') ?? '';
  const day = u.searchParams.get('day') ?? '';
  const placement = await getPlacement(placementId);
  if (!placement) return json(res, 404, { error: 'unknown placement' });
  const startMs = Date.parse(`${day}T00:00:00Z`);
  if (!Number.isFinite(startMs)) return json(res, 400, { error: 'day must be YYYY-MM-DD (UTC)' });
  const dayStartSec = Math.floor(startMs / 1000);
  const dayEndSec = dayStartSec + 86_400;
  const busy = await busyRangesForDay(placementId, dayStartSec, dayEndSec);
  json(res, 200, { placement: placementId, day, capacity: placement.capacity, dayStartSec, dayEndSec, busy });
}

function getNewspaper(res: http.ServerResponse): void {
  const active = adService.getActive();
  const featured = (active['newspaper-featured'] ?? [])[0] ?? null;
  const classifieds = active['classifieds'] ?? [];
  json(res, 200, { featured, classifieds });
}

// ── Advertiser sign-in ───────────────────────────────────────────────────────
async function postChallenge(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  if (!AD_MARKET_ENABLED) return json(res, 503, { error: 'the ad marketplace is not enabled' });
  const body = await readBody(req);
  const pubkey = typeof body.pubkey === 'string' ? body.pubkey.trim() : '';
  if (!isSolanaAddress(pubkey)) return json(res, 400, { error: 'a valid Solana address is required' });
  const nonce = randomBytes(16).toString('hex');
  const message = buildAdvertiserMessage(req.headers.host ?? 'worldofclaudecraft.com', pubkey, nonce);
  await createAdvertiserChallenge(nonce, pubkey, message, CHALLENGE_TTL_MINUTES);
  json(res, 200, { nonce, message });
}

async function postAuth(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  if (!AD_MARKET_ENABLED) return json(res, 503, { error: 'the ad marketplace is not enabled' });
  const body = await readBody(req);
  const pubkey = typeof body.pubkey === 'string' ? body.pubkey.trim() : '';
  const signature = typeof body.signature === 'string' ? body.signature.trim() : '';
  const nonce = typeof body.nonce === 'string' ? body.nonce.trim() : '';
  if (!isSolanaAddress(pubkey) || !signature || !nonce) return json(res, 400, { error: 'pubkey, signature, and nonce are required' });
  const challenge = await consumeAdvertiserChallenge(nonce);
  if (!challenge || challenge.pubkey !== pubkey) return json(res, 400, { error: 'challenge expired or unknown — request a new one' });
  if (!verifySolanaSignature(challenge.message, signature, pubkey)) return json(res, 401, { error: 'signature did not verify' });
  const advertiser = await upsertAdvertiser(pubkey);
  if (advertiser.blocked) return json(res, 403, { error: 'this advertiser is blocked' });
  const token = newToken();
  await saveAdvertiserToken(token, advertiser.id, ADVERTISER_TOKEN_TTL_DAYS);
  json(res, 200, { token, advertiserId: advertiser.id, pubkey: advertiser.pubkey });
}

// ── Creative upload ──────────────────────────────────────────────────────────
async function postCreative(req: http.IncomingMessage, res: http.ServerResponse, adv: { id: number }, u: URL): Promise<void> {
  const contentType = String(req.headers['content-type'] ?? '');
  if (contentType.includes('application/json')) {
    const body = await readBody(req);
    const text = typeof body.text === 'string' ? body.text.trim() : '';
    if (!text || text.length > MAX_TEXT_LEN) return json(res, 400, { error: `text is required (≤ ${MAX_TEXT_LEN} chars)` });
    if ([...text].some((ch) => ch.charCodeAt(0) < 0x20 || ch.charCodeAt(0) === 0x7f)) return json(res, 400, { error: 'text contains control characters' });
    const cta = cleanCta(body.cta);
    // Screen text + CTA against the hard-word list (defense in depth; admin review
    // is still the final gate).
    const hard = await hardWords();
    if (findHardWord(text, hard) || (cta && findHardWord(cta, hard))) {
      return json(res, 422, { error: 'this text is not allowed' });
    }
    const clickUrl = validClickUrl(body.clickUrl);
    const id = await insertTextCreative({ advertiserId: adv.id, text, clickUrl, cta });
    return json(res, 200, { creativeId: id, kind: 'text' });
  }
  // Binary PNG image creative.
  const bytes = await readBinaryBody(req, MAX_CREATIVE_BYTES);
  if (!isPng(bytes)) return json(res, 400, { error: 'image must be a PNG' });
  const dims = pngDimensions(bytes);
  if (!dims || dims.width < 1 || dims.height < 1 || dims.width > 4096 || dims.height > 4096) {
    return json(res, 400, { error: 'invalid PNG dimensions' });
  }
  const clickUrl = validClickUrl(u.searchParams.get('clickUrl'));
  const cta = cleanCta(u.searchParams.get('cta'));
  const id = await insertImageCreative({ advertiserId: adv.id, png: bytes, width: dims.width, height: dims.height, clickUrl, cta });
  json(res, 200, { creativeId: id, kind: 'image', width: dims.width, height: dims.height });
}

// ── Reserve a slot ───────────────────────────────────────────────────────────
async function postReserve(req: http.IncomingMessage, res: http.ServerResponse, adv: { id: number }): Promise<void> {
  const body = await readBody(req);
  const placementId = typeof body.placement === 'string' ? body.placement : '';
  const asset = body.asset;
  const startsAtMs = Number(body.startsAt);
  const minutes = Math.trunc(Number(body.minutes));
  const creativeId = body.creativeId === undefined || body.creativeId === null ? null : Number(body.creativeId);

  if (!isAdAsset(asset)) return json(res, 400, { error: 'asset must be USDC, SOL, or WOC' });
  if (!Number.isFinite(startsAtMs) || startsAtMs <= 0) return json(res, 400, { error: 'startsAt (epoch ms) is required' });
  if (startsAtMs % 60_000 !== 0) return json(res, 400, { error: 'startsAt must align to a whole minute' });
  if (!Number.isInteger(minutes) || minutes < 1 || minutes > AD_MAX_MINUTES) {
    return json(res, 400, { error: `minutes must be a whole number in 1..${AD_MAX_MINUTES}` });
  }
  const placement = await getPlacement(placementId);
  if (!placement || !placement.active) return json(res, 404, { error: 'unknown placement' });

  const startSec = startsAtMs / 1000;
  const endSec = startSec + minutes * 60;
  if (startsAtMs - Date.now() < AD_MIN_LEAD_MINUTES * 60_000) {
    return json(res, 400, { error: `bookings must start at least ${AD_MIN_LEAD_MINUTES} minutes ahead` });
  }
  const card = await getActiveRateCard(placementId);
  if (!card) return json(res, 503, { error: 'no rate card set for this placement' });
  if (minutes < card.min_minutes || minutes > card.max_minutes) {
    return json(res, 400, { error: `this placement allows ${card.min_minutes}..${card.max_minutes} minutes` });
  }
  // Validate the creative (if supplied) belongs to the advertiser and matches the surface type.
  if (creativeId !== null) {
    const creative = await getCreative(creativeId);
    if (!creative || creative.advertiser_id !== adv.id) return json(res, 400, { error: 'unknown creative' });
    if (creative.kind !== placement.creative_type) {
      return json(res, 400, { error: `this placement needs a ${placement.creative_type} creative` });
    }
  }
  const lockedPriceBase = ratePerMinuteForAsset(card, asset as AdAsset) * BigInt(minutes);

  const result = await reserveBooking({
    placementId,
    advertiserId: adv.id,
    creativeId,
    asset: asset as AdAsset,
    startSec,
    endSec,
    capacity: placement.capacity,
    lockedPriceBase,
    rateCardId: card.id,
    reserveTtlMinutes: AD_RESERVE_TTL_MINUTES,
  });
  if (!result.ok) {
    const msg = result.reason === 'capacity_full' ? 'that surface is fully booked for this window' : 'that slot was just taken';
    return json(res, 409, { error: msg, reason: result.reason });
  }
  json(res, 200, {
    bookingId: result.bookingId,
    lockedPriceBase: lockedPriceBase.toString(),
    minutes,
    asset,
    placement: placementId,
    reserveTtlMinutes: AD_RESERVE_TTL_MINUTES,
  });
}

// ── Quote (price lock) ───────────────────────────────────────────────────────
async function postQuote(req: http.IncomingMessage, res: http.ServerResponse, adv: { id: number; pubkey: string }): Promise<void> {
  const body = await readBody(req);
  const bookingId = Math.trunc(Number(body.bookingId));
  if (!Number.isInteger(bookingId) || bookingId < 1) return json(res, 400, { error: 'bookingId is required' });
  const booking = await getBooking(bookingId);
  if (!booking || booking.advertiser_id !== adv.id) return json(res, 404, { error: 'unknown booking' });
  if (booking.status !== 'reserved') return json(res, 409, { error: `booking is ${booking.status}, not reservable` });

  const asset = booking.asset;
  const treasury = adTreasury(asset);
  if (!treasury) return json(res, 503, { error: `no ${asset} treasury configured` });
  const priceBase = BigInt(booking.locked_price_base);
  const quoteId = randomBytes(16).toString('hex');
  await createAdQuote({
    quoteId,
    advertiserId: adv.id,
    bookingId,
    asset,
    priceBase,
    payerPubkey: adv.pubkey,
    payload: { placement: booking.placement_id },
    ttlMinutes: AD_QUOTE_TTL_MINUTES,
  });
  json(res, 200, {
    quoteId,
    memo: quoteId,
    asset,
    mint: adMint(asset),
    decimals: adDecimals(asset),
    amountBase: priceBase.toString(),
    treasury,
    payer: adv.pubkey,
    expiresAt: Date.now() + AD_QUOTE_TTL_MINUTES * 60_000,
  });
}

// ── Confirm (verify on-chain + settle) ───────────────────────────────────────
async function postConfirm(req: http.IncomingMessage, res: http.ServerResponse, adv: { id: number }): Promise<void> {
  const body = await readBody(req);
  const quoteId = typeof body.quoteId === 'string' ? body.quoteId.trim() : '';
  const signature = typeof body.signature === 'string' ? body.signature.trim() : '';
  if (!quoteId || !signature) return json(res, 400, { error: 'quoteId and signature are required' });

  const quote = await getAdQuote(quoteId, adv.id);
  if (!quote) return json(res, 400, { error: 'quote expired or already used — request a new one' });

  const asset = quote.asset as AdAsset;
  const priceBase = BigInt(quote.price_base);
  const bookingId = Number(quote.booking_id);

  // Verify the finalized payment BEFORE consuming the quote (a too-early confirm
  // returns 409 and can be retried without losing the quote).
  const payment = await verifyAdPayment(asset, signature, quote.payer_pubkey, priceBase, quoteId);
  if (!payment.ok) {
    const status = payment.reason === 'not_finalized' ? 409 : 400;
    return json(res, status, { error: `payment not verified (${payment.reason})`, reason: payment.reason });
  }

  // Replay guard: tx_sig UNIQUE — a signature settles exactly one booking.
  const rec = await recordAdPayment({
    advertiserId: adv.id,
    bookingId,
    asset,
    txSig: signature,
    mint: adMint(asset),
    amountBase: payment.spentBase,
    treasuryBase: payment.creditedBase,
    payerPubkey: quote.payer_pubkey,
    reference: `ad:${bookingId}:${quoteId}`,
  });
  if (!rec) return json(res, 409, { error: 'this payment was already used' });

  const bound = await markBookingPaid(bookingId, rec.id, signature);
  await deleteAdQuote(quoteId).catch(() => {});
  if (!bound) {
    // The reservation lapsed before payment finalized (rare — the quote TTL is
    // shorter than the reservation TTL). The payment is recorded against the
    // booking; admin can refund it. Surface a clear conflict.
    return json(res, 409, { error: 'the reservation expired before payment finalized — contact support for a refund', reason: 'reservation_lapsed' });
  }
  json(res, 200, { ok: true, bookingId, status: 'pending_review' });
}

async function getBookings(res: http.ServerResponse, adv: { id: number }): Promise<void> {
  const rows = await listAdvertiserBookings(adv.id);
  json(res, 200, {
    bookings: rows.map((b) => ({
      id: b.id,
      placement: b.placement_id,
      asset: b.asset,
      status: b.status,
      reviewStatus: b.review_status,
      lockedPriceBase: b.locked_price_base,
      startSec: b.start_sec,
      endSec: b.end_sec,
    })),
  });
}
