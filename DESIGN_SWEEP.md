# Claudium design sweep: inventory + gaps

Honest inventory of every Claudium surface in the game UI, current state, and
severity: breaks-trust > inconsistent > polish. UI is the in-game window
(src/ui/claudium_window.ts + claudium_view.ts + .cl-* in components.css).

## Screens that EXIST

| Surface | State | Notes |
|---|---|---|
| Balance row | exists | shows Claudium only, NO USD equivalent |
| Buy tab: rail picker | exists | Card/SOL/USDC/WOC, disabled state per rail |
| Buy tab: stripe SKU ladder | exists | USD + Claudium per row, aria labels |
| Buy tab: native quote panel | exists | amount, address, memo, split, countdown; NO QR |
| Redeem tab: gift code | exists | code input, credited/error result |
| Cosmetic store (spend) | exists | item name, kind, Claudium cost, redeem |
| Disabled (service-off) state | exists | notice + disclosure line; proven |

## Screens that are MISSING (not polish, unbuilt)

| Surface | Severity | Note |
|---|---|---|
| Gift card BUY / gift flow (denomination, recipient, message, scheduled delivery) | breaks-scope | DEFERRED (scoped follow-up, not built this sweep). The game UI only REDEEMS gift cards; there is no buy-a-gift flow. Issue + delivery live service-side only. |
| Transaction history view | inconsistent | DEFERRED (scoped follow-up, not built this sweep). The SDK has history(); no UI renders it. |
| Occasion gift-card artwork (birthday/holiday/generic) | polish | DEFERRED (scoped follow-up). service delivery.ts renders ONE generic styled card; no occasion variants. |
| Pay-address QR | inconsistent | FALLBACK SHIPPED (QR DEFERRED). A hand-rolled client-side QR encoder (src/ui/qr.ts) was built and passed unit tests, but its output did not decode with a reference scanner (jsQR), so per the sweep brief it was removed rather than ship an unscannable code. The pay panel now renders the address as LARGE COPYABLE MONOSPACE (.cl-address) with a Copy button (8164d645d), which satisfies the scan-alternative requirement. A correct QR encoder is a scoped follow-up. |

## Gaps on existing screens

| # | Screen | Issue | Severity | Status |
|---|---|---|---|---|
| D1 | components.css .cl-* | hardcoded colors (#463a1c, #ffffff08, #ffe27a, #8a6427, #160f08, #ffb07a, ...) instead of design tokens | inconsistent | FIXED ddaa70a37. Zero raw hex/rgba in the .cl-* block (grep-verified); all mapped to tokens (--color-border-default, --color-gold, --color-surface-inset/-well, --color-primary-glow, --color-text-*). |
| D2 | Balance | no USD equivalent (peg legibility rule: show Claudium AND USD) | breaks-trust | FIXED 2638a99af. Balance, store rows, SKU rows, review line all show "(Claudium ($USD))" via claudiumToUsd + formatNumber; peg = service usdPerClaudium, fallback CLAUDIUM_USD_PEG = $0.01. |
| D3 | Native pay panel | run-on labels in the recorded frame (sendExactly crowding, split "60 WOC burned140 WOC to treasury" ran together); verify spacing/rows | inconsistent | FIXED 2638a99af. Each field is its own .cl-field row (label block + value block); the split is one clean line "X WOC burned, Y WOC to treasury" on its own labelled row. |
| D4 | Tabs | Buy/Redeem tabs read as plain boxes in the recording; verify .cl-tab styling exists and reads as tabs | polish | FIXED 2638a99af (styling) + 0a7567c7b (role=tablist/tab/tabpanel, aria-selected, roving tabindex). |
| D5 | Native quote | no explicit "You pay X, you receive Y Claudium" review line before the confirm commit | breaks-trust | FIXED 2638a99af. Explicit Review row: "You pay X WOC, you receive Y Claudium ($Z)." before Confirm. |
| D6 | Pending/confirming | after paste-signature confirm, is there a calm "waiting for confirmation" state, or dead air? verify | breaks-trust | FIXED 2638a99af. Confirm shows a calm pending line "Waiting for on-chain confirmation..."; not_finalized shows a reassuring retry; expired/oracle offers a fresh quote. All plain-language, no raw reason codes. |
| D7 | Store | prices show Claudium only; "not enough Claudium -> top up" path back to buy not present | inconsistent | FIXED 0a7567c7b. Unaffordable items show "Not enough Claudium" + a "Top up" button that jumps to the buy tab and focuses the rail picker. |
| D8 | Themes | light+dark parity not verified across Claudium screens | inconsistent | FIXED ddaa70a37 (tokenize) + 8164d645d (theme-adaptive surface tokens). Verified in Midnight (dark) and Parchment (light) screenshots; the dark-only --color-bg-input assumption was replaced with theme-adaptive --color-surface-inset / --color-surface-well. |

## Fix priority (money-clarity + trust first)

1. D2 balance USD equivalent; D5 review line; D6 pending state; D3 pay-panel spacing (money clarity).
2. D1 tokenize colors; D8 theme parity (coherence).
3. D7 top-up path; D4 tab polish; QR affordance (polish).
4. Missing screens (gift-buy, history, occasion art): flagged as scoped follow-ups; the game UI ships redeem + buy + store now.

## Evidence (before/after screenshots)

`docs/screenshots/claudium/`, captured in BOTH a dark (Midnight) and light (Parchment) theme:
- `claudium_buy_<theme>.png` - buy tab, rail picker, SKU/amount ladder with USD.
- `claudium_pay_panel_<theme>.png` - native WOC pay panel: review line, per-row fields, one-line split, countdown, large copyable address + Copy.
- `claudium_pending_<theme>.png` - calm "Waiting for on-chain confirmation" pending state, plus the store top-up prompt below.
- `claudium_redeem_<theme>.png` - redeem tab (tabs read as tabs).
- `claudium_store_topup_<theme>.png` - cosmetic store with the "Not enough Claudium / Top up" affordance.
- `claudium_service_off.png` - the graceful-degradation disabled state (dark).

## Honest note

The gift-card BUY flow and transaction history are genuinely absent from the game UI, not merely unpolished, and stay DEFERRED as scoped follow-ups (this sweep did not stub them). The pay QR is a fourth deferred item: an encoder was built but did not decode cleanly, so the panel ships the sanctioned copyable-monospace fallback instead. This sweep fixed every gap on the EXISTING surfaces (D1-D8) and flags those four as the next build.
