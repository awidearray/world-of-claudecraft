# Claudium Next-Build UI (gift-card buy/gift + transaction history)

Branch: feat/woc-claudium-ui. Worktree: wt-claudium-ui.

## KEY ARCHITECTURE FINDING (seam correction)
The prompt's Milestone 2 assumes Claudium flows through the IWorld seam
(`src/ui/world_api.ts`, implemented in `src/sim/sim.ts` + `src/net/online.ts`). It
does NOT in this repo. Claudium flows through a dedicated SDK seam:

- `src/net/economy_sdk.ts` -> `EconomyClient`: typed fetch wrapper over the game
  server's `/api/claudium/*` routes. Already has `nativeQuote({rail, claudium,
  fulfillment})` where fulfillment can be `{kind:'giftcard', recipientEmail?,
  message?, deliverAtMs?}`, `nativeConfirm`, `redeemGiftCard`, `balance/skus/price/
  store/spend/purchase`. NO history-page method yet.
- `src/ui/hud.ts` -> `ClaudiumHooks` interface: the UI-side seam. The
  `ClaudiumWindow` reads it through injected deps. `Hud.attachClaudium(hooks)`.
- `src/main.ts` (~line 1642) wires `ClaudiumHooks` from a live `EconomyClient`.

`src/world_api.ts` (NOT `src/ui/world_api.ts`) is the game-state IWorld seam and has
nothing Claudium. `sim.ts`/`online.ts` have zero claudium refs. So Milestone 2 is
done by EXTENDING `EconomyClient` + `ClaudiumHooks` + the `ClaudiumWindow` deps + the
main.ts wiring, mirroring the existing pattern. This is the sanctioned "reuse the
existing settlement/SDK path" instruction, and it is the honest adaptation.

## Exact signatures (recorded)
### Service SDK (svc-daily-rewards/packages/sdk/src/claudium.ts)
- `LedgerReason = 'purchase_stripe'|'purchase_sol'|'purchase_usdc'|'purchase_woc'|
  'giftcard_redeem'|'spend'|'refund_clawback'|'chargeback_clawback'|
  'giftcard_void_clawback'`
- `LedgerEntryV1 { entryId; accountId:number; delta:number (+credit/-debit int
  Claudium); reason:LedgerReason; ref:string; atMs:number }`
- `ClaudiumHistoryPageV1 { entries: LedgerEntryV1[]; nextCursor: string|null }`
  route: `GET /v1/claudium/history/:accountId/page?limit=&before=`
  (`before` = entryId of last entry on prior page; newest-first)
- `NativeRail = 'sol'|'usdc'|'woc'`
- `NativeQuoteRequestV1 { rail; claudium:number; fulfillment: {kind:'credit';
  accountId} | {kind:'giftcard'; recipientEmail?; message?; deliverAtMs?} }`
  NOTE: no `occasion` field in the service type. Occasion is a UI concept mapping to
  the message/template; carry it as a UI-only selection folded into `message` OR a
  separate field if the service accepts extra keys. The prompt lists occasion in the
  giftcard fulfillment; service type omits it. DECISION: pass occasion through as
  part of the quote input; the SDK forwards `{recipientEmail?, message?, deliverAtMs?,
  occasion?}` (extra key is harmless JSON; server picks the template). Recorded as a
  reviewer-check item.
- `NativeQuoteV1 { reference:string; rail; claudium; amountBase; destination; mint;
  memo; quoteExpiryMs; split?{burnBase,treasuryBase,treasury}; reason? }`
- `ConfirmNativeV1 { settled:boolean; reason?; observedAmountBase?; fulfillment?:
  Record<string,unknown> }` giftcard fulfillment carries `giftCardCode` + `cardId`.

### Game-client SDK (src/net/economy_sdk.ts) -- already present
- `ClaudiumFulfillment = {kind:'credit'} | {kind:'giftcard'; recipientEmail?;
  message?; deliverAtMs?}`  (extend with occasion + reveal delivery kind)
- `EconomyClient.nativeQuote({rail, claudium, fulfillment}) -> ClaudiumNativeQuote`
- `EconomyClient.nativeConfirm({reference, signature}) -> ClaudiumNativeConfirm`
  (`.fulfillment` is `{balance:number|null; giftCardCode:string|null}` today; extend
  to carry cardId for gift flow success)
- ADD: `EconomyClient.historyPage({limit, before?}) -> ClaudiumHistoryPage`

### QR (svc-daily-rewards/service/src/qr/qr.ts) -> port to src/ui/qr.ts
- `encodeQr(text, {ecLevel?, minVersion?}) -> {size, modules: boolean[][]}` (incl
  4-module quiet zone; byte mode; versions 1..13; EC L/M/Q/H)
- `qrToSvg(text, {ecLevel?, moduleSize?, dark?, light?}) -> svg string`
  Defaults `dark='#000000' light='#ffffff'`. To keep src/ui/qr.ts hex-free, CHANGE
  defaults to `'currentColor'` / `'transparent'` and require the caller to pass token
  colors. Window passes theme tokens (resolved via CSS class, not TS hex).

## Design tokens available (tokens.css)
credit(+) = `--color-text-success` (#7fdc4f), debit(-) = `--color-text-error`
(#ff8f85), gold accent `--color-gold`, muted `--color-text-muted`, light
`--color-text-light`, surfaces `--color-surface-inset/-well`, border
`--color-border-default/-focus`, `--radius-sm`, `--font-serif`, `--cursor-pointer`.

## i18n
`src/ui/i18n.catalog/hud_chrome.ts` `claudium:` block (en-only module, no per-locale
TS enforcement). Add keys under `hudChrome.claudium.*`. Wordy new values (M16) also
need zh_CN/zh_TW/ja_JP/ko_KR/ru_RU fills in the overlays. Regen: `npm run i18n:gen`
then `node scripts/i18n_resolved_hash.mjs --write`; confirm idempotent.

## Commands
- tsc: `npm run check:ts`   vitest: `npx vitest run tests/<file>`
- biome (changed only): `npx @biomejs/biome check --write <file>`
- i18n: `npm run i18n:gen` + `node scripts/i18n_resolved_hash.mjs --write`
- shots: `node scripts/claudium_shot.mjs` (needs `npm run dev` on :5173)

## Milestones + status
- M0 recon: DONE
- M1 QR port + round-trip test: IN PROGRESS
- M2 SDK/hooks seams (historyPage + giftcard quote/confirm): TODO
- M3 gift-card buy/gift flow (view-core + window tab): TODO
- M4 transaction history view: TODO
- M5 verify + screenshots: TODO

## TODO / gaps log
- (M2) occasion field not in service NativeQuoteRequestV1: forwarded as extra JSON
  key; reviewer must confirm service accepts/ignores it. Scheduled delivery cron is
  service-side (deliverAtMs is stored; actual send is not this UI's job) -- note in
  final report as deferred/service-side.
