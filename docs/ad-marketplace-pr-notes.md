# Ad Marketplace — PR notes (read before merge)

The Claudemoon Gazette newspaper interstitial + the in-game advertising marketplace
(CRM, by-the-minute booking, USDC/SOL/WOC payments, refunds, billboards, ticker).
Whole surface is gated behind `AD_MARKET_ENABLED` (off by default).

## ⚠️ Needs an artist (do not ship the art as-is)
The newspaper masthead, paper texture, ornamental rules, and the in-world billboard
prop are a **CSS/procedural stand-in**, not final art. Commission an artist for:
- An engraved **vintage-broadsheet masthead** for "The Claudemoon Gazette" (the
  blackletter web font + double rules are a placeholder; see `index.html`
  `#newspaper-screen` / `.gazette`).
- Real **aged-newsprint paper texture** + foxing/stains (currently faked with
  layered CSS radial gradients).
- A proper **in-world billboard model/frame** (the renderer currently builds a
  simple framed plane — see `src/render/`).
- Optional period **cuts/engravings** and section ornaments.
The `ART TODO` markers are in `index.html` near `#newspaper-screen`.

## Real-world / partner advertising is in scope
The ad slots are designed for **real-world brands and partners** — apps, online
discounts, and offers players can buy on the web — not just in-game goods:
- Creatives carry an external `click_url` **and** a short `cta` call-to-action
  (e.g. "Get the app", "20% off — code WOC20"). Rendered as an external,
  `rel="noopener nofollow sponsored"` link on the newspaper, classifieds, and
  (later) billboards/ticker.
- Follow-ups worth considering: advertiser categories (in-game vs partner),
  promo-code field, app-store deep links, partner verification/KYB, and an
  affiliate/UTM passthrough on `click_url`.

## Open decisions (defaults chosen; confirm before mainnet)
1. **Deferred WOC burn** — WOC ad revenue goes 100% to treasury at payment; the
   configured `WOC_AD_BURN_BPS` (default 50%) is burned only after admin approval,
   so a rejected booking refunds in full. (Alternative: burn at payment, partial
   WOC refunds.)
2. **Treasury == refund keeper** — `AD_*_TREASURY` should be the refund keeper's
   own addresses so collected funds == refundable float. The keeper
   (`AD_REFUND_KEEPER_SECRET`) is the one custodial seam; off by default.
3. **Mainnet vs devnet first** — config supports both; recommend a devnet /
   test-mint shakeout before enabling on mainnet.
4. **Rate-card defaults, billboard world coords, classifieds capacity** — seeded
   placeholders in `server/ads_db.ts` (`PLACEMENT_SEEDS`) + `server/woc_config.ts`
   (`AD_PRICE_PER_MIN_*`); tune before launch.
5. **Newspaper lore source** — currently a static localized pool
   (`newspaper.lore1..4`); could become admin-authored or generated.

## Security / ops surface to review
- On-chain verification across 3 assets incl. native-SOL lamport-delta checks
  (`server/solana_tx.ts`, `server/ad_payment.ts`).
- Refund keeper hot wallet + deferred burn (`server/ad_refund.ts`).
- Advertiser-controlled text/images: escaped everywhere; images 404 until
  approved; reserve double-booking guarded by a Postgres `EXCLUDE` constraint.
