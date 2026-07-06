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
| Gift card BUY / gift flow (denomination, recipient, message, scheduled delivery) | breaks-scope | the game UI only REDEEMS gift cards; there is no buy-a-gift flow. Issue + delivery live service-side only. |
| Transaction history view | inconsistent | the SDK has history(); no UI renders it. |
| Occasion gift-card artwork (birthday/holiday/generic) | polish | service delivery.ts renders ONE generic styled card; no occasion variants. |
| Pay-address QR | inconsistent | native pay panel shows the address as text only; a QR would help wallet scanning. |

## Gaps on existing screens

| # | Screen | Issue | Severity |
|---|---|---|---|
| D1 | components.css .cl-* | hardcoded colors (#463a1c, #ffffff08, #ffe27a, #8a6427, #160f08, #ffb07a, ...) instead of design tokens | inconsistent |
| D2 | Balance | no USD equivalent (peg legibility rule: show Claudium AND USD) | breaks-trust |
| D3 | Native pay panel | run-on labels in the recorded frame (sendExactly crowding, split "60 WOC burned140 WOC to treasury" ran together); verify spacing/rows | inconsistent |
| D4 | Tabs | Buy/Redeem tabs read as plain boxes in the recording; verify .cl-tab styling exists and reads as tabs | polish |
| D5 | Native quote | no explicit "You pay X, you receive Y Claudium" review line before the confirm commit | breaks-trust |
| D6 | Pending/confirming | after paste-signature confirm, is there a calm "waiting for confirmation" state, or dead air? verify | breaks-trust |
| D7 | Store | prices show Claudium only; "not enough Claudium -> top up" path back to buy not present | inconsistent |
| D8 | Themes | light+dark parity not verified across Claudium screens | inconsistent |

## Fix priority (money-clarity + trust first)

1. D2 balance USD equivalent; D5 review line; D6 pending state; D3 pay-panel spacing (money clarity).
2. D1 tokenize colors; D8 theme parity (coherence).
3. D7 top-up path; D4 tab polish; QR affordance (polish).
4. Missing screens (gift-buy, history, occasion art): flagged as scoped follow-ups; the game UI ships redeem + buy + store now.

## Honest note

The gift-card BUY flow and transaction history are genuinely absent from the game UI, not merely unpolished. This sweep polishes what exists and flags those as the next build, rather than pretending they are present.
