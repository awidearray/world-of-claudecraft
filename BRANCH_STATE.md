# Branch state: feature/woc-realm-token-launchpad-impl

Realm Token Launchpad, phases 0 to 8 of
`docs/prd/woc/realm-token-launchpad.md`, implemented on the #475 realm base
freshened with release/v0.23.0 (merge 2bb4d5084). Deliverable is this pushed
branch; NO upstream PR yet (the #799/#475 chain is blocked, see the recipe at
the bottom).

## Locked decisions honored

- Presale/vote identity = game account + verified linked wallet (the #473
  rail). An unlinked account is rejected with the typed `wallet_not_linked`
  error on both the vote and presale paths.
- Commerce core = a FORK of this branch's `realm_buy` quote/verify/confirm
  machinery (`server/realm_presale.ts` mirrors `server/realm_buy.ts` shape,
  reusing `parseSplitPayment` / `parseNativePayment` /
  `fetchFinalizedTransaction`). This is the fourth fork of the shared shape;
  convergence is a documented follow-up (see Open questions).
- `monetization_policy` defaults `'cosmetic'` and is STORAGE ONLY: no power
  behavior reads it anywhere in phases 0 to 2 (the token-to-copper credit path
  is phase 7 behind its own gate). The UI labels a `power` realm plainly.

## Commits (one series per phase, each commit tsc-clean in isolation)

| Commit | Phase | What |
|---|---|---|
| 047965f1b | 0 | `feat(realm-token)`: registry + resolver + directory identity |
| e5c481a25 | 1 | `feat(realm-vote)`: weighted off-chain launch vote |
| 1c0c24b5d | 2 | `feat(realm-presale)`: asset-only non-custodial presale + surface-inventory registration |
| 2ae0ef47c | 1+2 UI | `feat(ui)`: launchpad panel + view-core + i18n domain + wiring |
| 224d03e87 | 3 | `feat(realm-mint)`: Token-2022 mint factory, allocation locks, listing gate |
| ffdc994e3 | 4+5 | `feat(realm-curve)`: Meteora DBC launch + DAMM v2 graduation + fee keeper |
| a344499b3 | 6 | `feat(levy-fund)`: display-only Levy Street Fund portfolio + tiered valuation |
| 6cef3a417 | 7 | `feat(realm-currency)`: IWorld currency re-skin + power-realm token-to-copper |
| (HEAD) | 8 | `feat(reg-hardening)`: OFAC/geo money gate + counsel gate + ToS + clean-score |

## Phase 0: registry + identity

Files: `server/realm_token.ts` (types, validation, pure
`realmTokenConfig(realmId, tokens)` resolver falling back to the $WOC display
currency, `mergeDirectoryCurrencies`, register orchestration against the
`RealmTokenDb` interface), `server/realm_token_db.ts` (`realm_tokens` table:
symbol/icon, 9-state lifecycle, `monetization_policy` CHECK defaulting
cosmetic, `launch_tx_sig UNIQUE` reserved for the phase-3 mint, guarded status
CAS). `assertRealmSchema` (server/realm_db.ts) extended: a dropped
`realm_tokens` (or vote/presale) column fails at boot. `GET /api/realms` now
attaches an additive, FAIL-OPEN `currency` field per directory entry. Routes:
`POST /api/realms/:id/token/register` (owner-only, active realm, one token per
realm), `GET /api/realms/:id/token`. No chain writes; `mint` stays NULL until
phase 3.

Acceptance:
- In-memory-fake test + register/resolver/directory-merge coverage:
  `tests/realm_token.test.ts` (18 tests, green).
- Real-DB variant per the `realm_db.integration.test.ts` pattern:
  `tests/realm_launchpad_db.integration.test.ts` (9 tests, green against
  Postgres 16 via `PG_TEST_URL`), including boot-fail-on-dropped-column
  (`ALTER TABLE realm_tokens DROP COLUMN monetization_policy` makes
  `assertRealmSchema` throw) and the guarded CAS.
- Boot-fail also unit-tested without Postgres via a stubbed Queryable.
- Directory merge test: currency attaches additively, env-only realms and
  closed tokens fall back to $WOC.

## Phase 1: launch vote

Files: `server/realm_vote.ts` + `server/realm_vote_db.ts`. Off-chain advisory
tally weighted by `cachedWocBalance` (whole $WOC, floored), SNAPSHOTTED into
the ledger row at cast time (a later balance change never rewrites a tally).
One vote per linked wallet AND per account (`UNIQUE(realm_id, wallet)` +
`UNIQUE(realm_id, account_id)`). Env quorum + yes threshold
(`REALM_VOTE_QUORUM_WOC`, default 1,000,000 $WOC;
`REALM_VOTE_YES_THRESHOLD_BPS`, default 6000), exact bigint outcome math. A
pass flips `voting -> presale` via the registry CAS, exactly once. Routes:
`POST .../token/vote/open` (owner), `GET`/`POST .../token/vote` (cast is
rate-limited: it reads the balance RPC).

Acceptance (`tests/realm_vote.test.ts`, 13 tests, green):
- Weighted tally + exact quorum/threshold boundaries (pass exactly at both,
  fail one unit under), whale-scale bigint weights.
- Double-vote rejection (same wallet, and same account with a rotated wallet).
- Unlinked wallet -> typed `wallet_not_linked`; null balance -> 503; zero
  whole-$WOC weight rejected.
- Pass flips voting -> presale; late votes rejected; met-quorum-failed-threshold
  stays `voting`.
- Real-DB: vote uniques + bigint round-trip in the integration suite.
- Panel view-core tested (see UI); S3 i18n guard green.

## Phase 2: presale (asset-only, non-custodial)

Files: `server/realm_presale.ts` + `server/realm_presale_db.ts` (tables
`realm_presales` config, `realm_presale_quotes`,
`realm_presale_contributions` with `pay_tx_sig UNIQUE` +
`refund_tx_sig UNIQUE`). Rails: SOL (native), USDC, $WOC (legacy SPL;
Token-2022 hard-rejected). Stripe fiat DEFERRED (noted in the panel copy).
Flow: owner configures the presale (founder-owned escrow wallet + per-rail
caps) once the vote passes; contributor quotes (memo == quoteId, TTL) and pays
ONE transfer into the escrow; confirm verifies the finalized tx and inserts
the contribution LEDGER-FIRST under a `SELECT ... FOR UPDATE` presale row
lock with an exact cap recheck. Combined soft cap = exact bigint fraction sum
across rails (asset-only: no pricing, no oracle). Owner finalize:
`presale -> funded` (soft cap met) or `-> refunding`; refunds are
founder/escrow-signed transactions the server only VERIFIES (fee payer must be
the escrow wallet, contributor credited in full, memo == the contribution's
pay signature binding one refund tx to one contribution); all rows refunded
flips `refunding -> refunded`.

Acceptance (`tests/realm_presale.test.ts`, 32 tests, green):
- Verifier rejects wrong-amount (`escrow_short`), wrong-recipient, replayed
  signature (second confirm with the same sig -> 409
  `contribution_already_recorded`, quote consumed), memo mismatch, wrong
  payer, reverted/unfinalized txs, Token-2022 look-alikes, malformed sigs
  (pre-RPC).
- Caps exact at boundaries: at-cap accepted, one base unit over rejected, for
  both the per-wallet and total-raise caps, including a raced contribution
  landing between quote and confirm (rechecked under the lock).
- Refund path: verified escrow-signed refund marks the row; double refund and
  refund-tx reuse rejected; status flips to `refunded` when all covered;
  short/wrong-recipient/wrong-refunder refunds rejected.
- Grep-level non-custodial assertion: a test scans `server/realm_presale.ts` +
  `realm_presale_db.ts` for any keypair/signing/secret material and fails on a
  match. No settle keypair exists anywhere in the presale path.
- Real-DB: config rails round-trip, ledger UNIQUEs, refund marking,
  `withPresaleLock` commit/rollback atomicity.

## Phase 3: Token-2022 mint factory + allocation locks

Files: `server/realm_token_alloc.ts` (pure allocation math: 60/10/12/8/10
default bps with hard caps founder 15 / levy 10 / treasury 15 and a 50 percent
public-curve floor; exact bigint split with the division dust in the public
bucket so the five buckets sum to EXACTLY the supply; vesting schedules with
env that can only LENGTHEN, founder 12mo cliff + 36mo linear, levy 12 + 48 the
strictest on the cap table, treasury 12 + 36; the `canListRealmToken` listing
gate), `server/solana_token2022.ts` (the SCOPED Token-2022 verifier: pure
`parseToken2022Movement` delta parser that flags a legacy-program look-alike,
jsonParsed mint narrowing, and the RugCheck-style `mintRugSummary` checklist
with the boring-extension whitelist), `server/jup_lock.ts` (Jupiter Lock
`create_vesting_escrow_v2` instruction builder + 296-byte bytemuck
`VestingEscrow` decoder + `verifyLockedEscrow` immutability verdict,
transcribed from the DEPLOYED program's on-chain Anchor IDL v0.4.0 and
byte-validated against a live devnet escrow before writing),
`server/realm_token_mint.ts` (the three-step non-custodial launch
orchestration), `server/realm_token_mint_db.ts` (`realm_launch_quotes` JSONB
quote pins). Deps: `@solana/spl-token` + `@solana/spl-token-metadata` added
(the alternative is hand-encoding Token-2022 init).

The launch flow (all founder-signed, server verify-only):
1. CREATE (`POST .../token/mint/quote` + `/confirm`): server builds one
   create-mint tx (metadata-only Token-2022, 9dp, freeze NEVER set, immutable
   metadata pointer to itself, memo == quoteId), partial-signs with a TRANSIENT
   mint keypair (never persisted, never returned), founder co-signs and pays
   rent. Confirm verifies the finalized tx (memo, fee payer) AND the on-chain
   mint state (program, decimals, zero supply, founder mint authority, null
   freeze, symbol, no forbidden extensions), then records mint +
   `launch_tx_sig` (UNIQUE) under a mint-IS-NULL + status-funded CAS.
2. DISTRIBUTE + RENOUNCE (`POST .../token/distribute/quote` + `/confirm`): ONE
   atomic tx mints public-curve + liquidity to the presale escrow wallet (the
   phase-4 curve seed), founder + levy + treasury to the founder's ATA for
   immediate locking, then renounces the mint authority AND the metadata
   update authority in the same tx. Confirm verifies exact per-owner
   Token-2022 deltas (merged when escrow == founder), memo, fee payer, final
   supply == pinned supply, and a fully CLEAN rug summary, then records
   `distribute_tx_sig` (UNIQUE) + the pinned bucket amounts
   (NUMERIC(30,0) as bigint).
3. LOCK x3 (`POST .../token/lock/quote` + `/confirm`): per bucket, an
   immutable Jupiter Lock escrow (update_recipient_mode == 0 AND
   cancel_mode == 0: nobody can redirect or cancel), recipient founder /
   REALM_TOKEN_LEVY_WALLET / founder(treasury), exact pinned vesting params,
   the escrow ATA created in the same tx (the deployed program does not init
   it). Confirm decodes the ON-CHAIN escrow account and requires exact mint /
   recipient / immutability / param match plus a fully funded escrow ATA, then
   records the address once (null-column CAS).

Listing gate: `markTokenLive` is the only door to `live` and requires founder
+ levy + LP locks all recorded (PRD section 7); with no LP lock until phase 4,
every token stays unlisted. `GET .../token/launch` serves the checklist.

Acceptance:
- `tests/realm_token_alloc.test.ts` (13 tests): split sums to 100 percent for
  adversarial supplies, caps + curve-floor fallback, env can only lengthen
  schedules, levy-strictest pin, lock math reconstructs the bucket amount
  exactly, listing-gate matrix.
- `tests/realm_token_mint.test.ts` (28 tests): every tampered dimension of all
  three confirms rejected (memo/payer/decimals/freeze/premine/symbol/forbidden
  extension/authority; short bucket/unrenounced/extra recipient/supply drift;
  mutable/underfunded/missing escrow), cross-realm launch-sig replay, jup-lock
  ix encoding byte-exact + account order per the deployed IDL, escrow decode
  round-trip, and the non-custodial pin (source scan: no secretKey /
  fromSecretKey / file IO in the factory; no Keypair at all in jup_lock.ts;
  quote payloads carry no 64-byte arrays).
- Real-DB integration (`tests/realm_launchpad_db.integration.test.ts`, now 12
  tests green): guarded launch writes (status CAS, once-only columns), UNIQUE
  launch/distribute sigs across realms, NUMERIC(30,0) bigint round-trip past
  2^63, JSONB quote round-trip + expiry pruning, boot-fail on a dropped
  `distribute_tx_sig`.
- DEVNET DRY-RUN GREEN (`tests/realm_token_mint.devnet.test.ts`, gated
  WOC_DEVNET_TEST=1, run 2026-07-11 against api.devnet.solana.com with the
  funded deployer as founder): the full flow through the production builders +
  verifiers. On-chain artifacts (devnet):
  - mint `6LE9UCRyZxMyjELkdaQdYZqV7uaTjXJML4XAfHaTGWoL`: supply exactly
    1e18 base (1B tokens at 9dp), mintAuthority null, freezeAuthority null,
    metadata symbol DRYRUN with updateAuthority null, metadataPointer -> self
    with authority null, extensions only {metadataPointer, tokenMetadata}
    (RugCheck-clean by construction, asserted via mintRugSummary).
  - create tx `344HfQkZfeko4L5Ter6fB2bfrLva36cTBB7id64nR9uayE4oDfW69NP9ESDQqng6y7SaB9NUwc3J5MWywNJy9Kke`,
    distribute+renounce tx `3rkNo5KuaEu2ZFeKd2YP3JJVPoQdeiudMNKrToW25PkdBpAySrPQ7CataeJUx7DgDFsgGRQyrWPuRzy5Xtk5CkLK`.
  - immutable Jupiter Lock escrows: founder
    `3im1K5gykdNEcwin7gLLnvzawEVAATRQ1WFjxKuQeGeX`, levy
    `EqSd3YBvnEkJJgQpNAhTMsAHWDtkSCCJwRdvkCZdZQyz`, treasury
    `HCsAAvQAUQn7dqnQUzkYW3JYaAGJ2P4i484gmNvZWQSS` (each verified on-chain:
    modes 0/0, exact params, fully funded escrow ATA).
  - the LEGACY parser rejects the new mint on the REAL distribute tx
    (`parseSplitPayment(...).usesToken2022ForMint === true`), re-pinning the
    stake/buy/presale Token-2022 rejection against a live Token-2022 transfer.
  - devnet learning encoded in the builder: the deployed lock program expects
    the escrow ATA to already exist, so the lock tx creates it idempotently.
- Routes inventoried: all 7 new routes registered in
  `tests/server/http/surface_inventory.ts` + `content_type_classification.ts`
  (the only remaining inventory diff is the pre-existing
  `/internal/woc/season/*` pair).
- i18n: 17 new `launchpad.err.*` codes mapped in ERR_KEYS, English catalog
  entries + the five non-Latin M16 fills each (zh_CN/zh_TW/ja_JP/ko_KR/ru_RU),
  ERR_KEYS coverage test extended; artifacts + hash baseline regenerated.

## Phase 4: Meteora DBC bonding curve + DAMM v2 graduation

Files: `server/realm_launchpad.ts` (the thin `LaunchVenue` seam + the pure
`CurveLaunchPlan` mapping the phase-3 allocation onto on-chain CONFIG
commitments + `verifyCurveConfigFacts` comparing LIVE facts to the pinned plan
+ the fixed-rate `StubLaunchVenue` for tests/pre-mainnet; the fee claimer MUST
be off-curve, `curveFeeClaimer` rejects an on-curve EOA), `server/realm_launchpad_dbc.ts`
(the `MeteoraDbcVenue` over @meteora-ag/dynamic-bonding-curve-sdk 1.5.10:
`buildCurve` config, `createConfigAndPool`, live reads of config/pool/migration
state, size-aware `swapQuote` sell quote, and the permissionless migration
cranks), `server/realm_token_curve.ts` (the launch/reconcile/leftover
orchestration on the phase 0 to 3 lifecycle). Dep: the DBC SDK + `bn.js` types.

The curve path (all founder-signed, server verify-only):
1. LAUNCH (`POST .../token/curve/quote` + `/confirm`): ONE founder tx creates
   the venue config + pool; the POOL creates the base mint (Token-2022,
   immutable authority by construction). Confirm verifies the LIVE on-chain
   config against the pinned plan (immutable authority, DAMM v2 migration, 100
   percent permanently locked LP, founder vesting == founder bucket, quote
   mint, PDA fee claimer, founder leftover receiver), then records mint /
   launch_tx_sig / curve / pool / fee_claimer + the pinned bucket amounts in
   one guarded write. Allocation maps onto the curve: public 60 sells on the
   curve, liquidity 10 into the permanently-locked DAMM v2 LP, founder 12 into
   the config's locked vesting (the SAME Jupiter Lock program phase 3 uses,
   cliff FROM MIGRATION), levy 8 + treasury 10 as the config leftover.
2. RECONCILE (`POST .../token/curve/reconcile`, idempotent): once migrated,
   decodes the founder-vesting locker escrow with the phase-3 decoder and
   `verifyVenueLockerEscrow` (the venue's escrow uses update_recipient_mode
   OnlyRecipient and cancel_mode OnlyCreator where the creator is an off-curve
   program PDA that can never sign, so cancellation is unreachable), records
   founder_lock + lp_lock (the DAMM v2 pool), and walks funded -> live
   (markTokenLive, the only door) -> graduated.
3. LEFTOVER (`POST .../token/curve/leftover/quote` + `/confirm`): withdraws the
   levy + treasury buckets to the founder ATA; confirm verifies the founder was
   credited AT LEAST the reserved levy + treasury (a partial-fill curve
   completion leaves a small unsold-curve remainder in the leftover, the
   operator's, outside the lock scheme), records it as the distribution, then
   the UNCHANGED phase-3 lock-quote flow locks the levy and treasury buckets
   (the founder bucket is locker-managed, so its phase-3 lock is refused on the
   curve path).

Acceptance:
- `tests/realm_token_curve.test.ts` (18 tests): the plan + off-curve fee-claimer
  gate, the live-config verifier against every tampered dimension, the
  buildCurve -> normalize -> re-verify round-trip (the built config read back
  as an account passes the pinned-plan verifier, vesting total == founder
  bucket exactly), the stub venue, and the full quote/confirm/reconcile/leftover
  orchestration ending with the phase-3 lock flow taking over levy + treasury
  and the listing gate opening.
- DEVNET INTEGRATION GREEN (`tests/realm_token_curve.devnet.test.ts`, gated
  WOC_DEVNET_TEST=1, run 2026-07-11 against api.devnet.solana.com, ~114s): the
  REAL Meteora DBC venue end to end with a 1-SOL migration threshold: launch
  config+pool -> buy 0.3 SOL (size-aware sell quote becomes real) -> partial-fill
  swap2 completes the curve -> createLocker -> migrateToDammV2 -> reconcile
  (founder vesting locker + DAMM v2 LP recorded, both verified on-chain) ->
  withdraw leftover -> jup-lock levy + treasury -> reconcile -> live ->
  graduated. All server verifiers ran against real accounts.
- Devnet learnings encoded: the lock program expects the escrow ATA to exist
  (created idempotently); a completing buy must be a partial-fill swap2 (a plain
  exact-in past the remaining curve base reverts InsufficientLiquidity); the
  venue locker's cancel_mode is 1 with an off-curve PDA creator (accepted by the
  scoped venue-locker verdict, distinct from our own mode-0 immutable locks).

GATE (unchanged): the phase-4 ACCEPTANCE is a MAINNET dry-run requiring the
owner's explicit sign-off. Everything is built + devnet-proven; NO mainnet
transaction was made. `REALM_LAUNCHPAD_VENUE` defaults unset (curve launches
disabled); `stub` is the fixed-rate pre-mainnet host, `meteora_dbc` is
production. `REALM_LAUNCHPAD_FEE_CLAIMER` must be an ops-owned off-curve PDA.

## Phase 5: source-scoped fee revenue keeper

Files: `server/realm_fee_split.ts` (pure four-leg split: operator minus the
affiliate cut / affiliate / global treasury / burn, summing to exactly the
input with dust in the operator leg; env-clamped to a 10000-bps identity),
`server/realm_fee_keeper.ts` (the CLAIM/ACCRUE/DRAIN orchestration over injected
interfaces), `server/realm_fee_db.ts` (`realm_fee_accruals` +
`realm_fee_distributions`, both ledger-first with UNIQUE tx-sig guards + the
per-realm advisory TRY-lock). Boot-started interval in main.ts (like the
buyback keeper), no-op unless configured.

Flow: ops claims each pool's DBC partner fees (claimable only by the phase-4
fee-claimer PDA) with the keeper vault as receiver; `POST /internal/woc/fee/register`
(WOC_OPS_SECRET-gated, the season-ops pattern) verifies the finalized claim
credited the vault and accrues it per realm (UNIQUE(claim_tx_sig)); `runFeeCycle`
drains each realm's accrued-minus-distributed balance under the per-realm
advisory TRY-lock (a contended realm is SKIPPED, never double-paid), cutting the
four legs ledger-first (the distribution row + every leg signature durable
BEFORE each broadcast, so recovery resolves by recorded signature and a crash
never double-pays). The burn leg is the pluggable terminal: the realm-buyback
vault (whose existing keeper swaps to $WOC and burns) or an LP-seed dest.

Acceptance:
- `tests/realm_fee_split.test.ts` (7 tests): exact four-leg division, affiliate
  out of the operator side, env clamp + wholesale fallback, sum-to-total for
  adversarial amounts.
- `tests/realm_fee_keeper.test.ts` (8 tests): verify-and-accrue with the replay
  guard, the four-leg drain, the floor / unpayable / missing-config guards, the
  advisory-lock skip (no double-pay), and crash recovery by recorded leg
  signature (a half-paid distribution's already-broadcast leg is confirmed by
  its recorded sig, NOT re-sent; only the never-attempted leg sends anew).
- Real-DB integration (in `realm_launchpad_db.integration.test.ts`, now 15
  tests): accrual replay guard, exact per-realm attribution off the shared
  vault, the leg-sig UNIQUE across rows, the advisory TRY-lock (a nested holder
  is skipped not blocked), listFeeRealms surfacing only curve realms.

The `/internal/woc/fee/*` pair is legacy-only WOC_OPS ops, joining the existing
`/internal/woc/season/*` pair in the same waived-inventory category (they cannot
be surface-inventoried without RouteDef registration; a pre-existing gate
conflict, not new debt).

## Phase 6: Levy Street Fund + tiered valuation

Files: `server/token_valuation.ts` (the pure tiered valuation over an injected
`PriceSources` seam: pre-grad size-aware curve mark, post-grad Jupiter v3
cross-checked against Birdeye + DEX Screener, Pyth SOL/USD with a confidence
band, the sqrtPrice math, the rolling median, the AUM clamp; EXCLUDE never
zero), `server/levy_fund.ts` (the display-only fund logic + valuation refresh),
`server/levy_fund_db.ts` (`levy_fund_snapshots` + `levy_fund_holdings` +
`levy_fund_marks` caches), `server/levy_fund_sources.ts` (the real Jupiter /
Birdeye / DEX Screener / Pyth / venue fetches, all fail-soft to illiquid),
`src/ui/levy_fund_view.ts` (the pure portfolio render model, registered in
UI_PURE_CORES), `src/ui/levy_fund_panel.ts` (the thin display-only DOM consumer).

THE ABSOLUTE LINE (PRD sections 8 + 14): the fund is DISPLAY-ONLY. It mints NO
fund-share token, sells NO claim, offers NO redemption; there is no buy / sell /
deposit / withdraw / redeem path anywhere in the module, the DB, the route, or
the panel. The only writes are the valuation keeper's cached snapshots; the only
reads are the public portfolio page. A source-scan test pins the absence.

The fund holds the levy allocation (default 8 percent, capped 10) of every
launched realm token, vested to the Levy Street Fund wallet through the phase-3
Jupiter Lock (the levy lock's recipient is `levyFundWallet()`, both on the
direct-mint and curve paths). The valuation keeper (boot-started interval,
default 30s per PRD) enumerates every launched realm token's levy allocation,
prices each on the tiered pipeline, median-smooths per mint, clamps the
single-refresh AUM jump, and writes a snapshot. `GET /api/levy-fund` (PUBLIC,
no auth) serves the latest snapshot; the panel renders the AUM header + one
sorted row per holding (illiquid rows excluded from AUM, kept visible with a
tag).

Acceptance:
- `tests/token_valuation.test.ts` (13 tests): sqrtPrice math, the pre-grad and
  post-grad tiers, every exclusion path (curve cannot quote size, no Jupiter
  route, cross-check divergence, liquidity floor, no cross source, unreliable
  Pyth) EXCLUDING never zeroing, the rolling median, the AUM clamp.
- `tests/levy_fund.test.ts` (9 tests): the refresh values a graduated holding
  with weights, EXCLUDES an illiquid holding from AUM while keeping its row, the
  per-mint median, the AUM clamp against the previous snapshot, the empty state,
  and the source-scan securities bright line (no redeem / share / sell symbols).
- `tests/levy_fund_view.test.ts` (4 tests): the render model, value-desc sort
  with illiquid last, weight percents, empty state.
- Real-DB integration (in `realm_launchpad_db.integration.test.ts`, now 16
  tests): snapshot round-trip + latest read, rolling marks bounded + oldest-
  first, holding sources surfacing only listed realms.
- `tests/architecture.test.ts` green (the view-core is registered in
  UI_PURE_CORES; no DOM / nondeterminism in it).

Entry-point follow-up: the panel + Api method (`Api.levyFund`) are complete and
tested; a HUD host hook to open the panel from the realm directory is a UI
follow-up (needs a running dev server to verify), mirroring the phases-0-to-2
"player entry point" follow-up.

## Phase 7: in-world currency re-skin + power-realm copper credit

Files: `src/world_api/inventory.ts` (the `CurrencyIdentity` type +
`CLASSIC_CURRENCY` + the `currencyIdentity` data member added to
`IWorldInventory`, alongside `copper`), `src/sim/sim.ts` (a constant classic
default, inlined so the sim keeps its TYPE-ONLY edge to the seam),
`src/net/online.ts` (the `ClientWorld` field set from the `hello` currency),
`server/game.ts` (`realmCurrency` field sent in both `hello` messages + the
`creditCopperToAccount` grant), `server/main.ts` (`resolveRealmCurrency` at
boot from the realm_tokens registry), `src/ui/hud.ts` (`moneyHtml` re-skin),
`server/realm_power_credit.ts` + `realm_power_credit_db.ts` (the power path).

The re-skin (the display half): the sim keeps an OPAQUE numeric `copper`
balance and stable string keys exactly as before; the currency IDENTITY
(symbol/icon/realmToken) is pure display data resolved server-side and surfaced
on IWorld. No mint / decimals / RPC / price ever enters src/sim/ (the sim's
`currencyIdentity` is a plain literal, type-imported only), so
`tests/architecture.test.ts` stays green. The offline Sim is always classic
coins; the online ClientWorld re-skins from the server's `hello` (resolved from
the realm_tokens registry, only for a live/graduated token). The HUD's
`moneyHtml` shows the flat "{amount} {symbol}" for a realm token, the classic
gold/silver/copper otherwise.

The power credit (the pay-to-win half, PRD section 6): a verified,
policy-gated, FLAG-DEFAULT-OFF path (`REALM_POWER_CREDIT_ENABLED`, the phase-8
mainnet gate). `creditTokenToCopper` credits copper ONLY after checking the
realm's monetization_policy is `power` (a cosmetic realm rejects it outright),
verifying a FINALIZED Token-2022 transfer of the realm token into the power
sink via the phase-3 scoped verifier, and a ledger-first UNIQUE(pay_tx_sig)
replay guard. The copper is applied through the sim's server-only `grantBonus`,
so the sim sees only opaque copper credited through its normal API and never
learns the source was a token.

Acceptance:
- `tests/world_api_parity.test.ts` (updated to 205 / 55 / 150) green: the new
  `currencyIdentity` data member is present + readable on BOTH Sim and
  ClientWorld.
- `tests/architecture.test.ts` green: nothing chain-shaped entered src/sim/.
- `tests/realm_currency_reskin.test.ts` (10 tests): the identity on both worlds
  (offline always classic, ClientWorld from a hello, malformed/absent hello
  keeps the default), the exact token-to-copper conversion, and the power
  credit with the monetization_policy gate, the flag gate, every verify
  rejection (wrong payer / no sink credit / foreign program / reverted / bad
  sig), the sub-copper rejection, and the ledger replay guard.
- Real-DB integration (in `realm_launchpad_db.integration.test.ts`, now 17
  tests): the power-credit UNIQUE(pay_tx_sig) replay guard.
- i18n: 9 new `launchpad.err.*` power codes mapped + English catalog + M16 fills
  + ERR_KEYS coverage extended.

GATE: the power path is the same high-reg-risk band as the wager features; it
stays flag-default-off until the phase-8 counsel sign-off + geo screening.

## Phase 8: regulatory hardening + mainnet gate

Files: `server/money_geo_gate.ts` (the OFAC SDN + IP-geo money-route middleware +
the counsel/mainnet gate helpers), `server/main.ts` (the screen applied to every
mutating token-money route + the Levy Fund page counsel gate),
`docs/legal/facilitator-tos.md` (the non-custodial facilitator terms for counsel
review), `docs/legal/counsel-signoff.md` (the mainnet enablement checklist +
sign-off record). Pay-to-win labeling was already surfaced from phase 0 (the
directory currency carries `monetizationPolicy`; the launchpad catalog carries
`policy.power` / `policy.powerBanner`).

The gate posture (fail-closed on mainnet): `screenMoneyRequest` runs for every
mutating token-money route (vote / presale / mint / distribute / lock / curve /
power-credit). On a NON-mainnet cluster it passes (devnet money is not real). On
MAINNET it requires BOTH the geo gate enabled (`MONEY_GEO_GATE_ENABLED=1`) AND
the counsel sign-off recorded (`LAUNCHPAD_COUNSEL_SIGNOFF` non-empty); without
either it returns 403 `geo_gate_required`. With both, it screens the edge
country (Cloudflare CF-IPCountry, fail-closed on unknown) against
`MONEY_BLOCKED_COUNTRIES` (defaults to the sanctioned set) and the payer wallet
against the OFAC SDN list (`OFAC_SDN_WALLETS` / `OFAC_SDN_WALLETS_FILE`). The
display-only Levy Fund page carries the same counsel gate on mainnet (PRD
section 8's Investment-Company-Act memo precondition); `mainnetMoneyEnabled` is
the single feature-gate helper every risky path composes.

Acceptance:
- `tests/money_geo_gate.test.ts` (16 tests): the pure verdict by cluster, the
  mainnet gate+counsel requirement, the geo-blocked + sanctioned-wallet +
  fail-closed-on-unknown branches, the SDN + country + counsel loaders, the edge
  country resolution, the `mainnetMoneyEnabled` feature gate, AND the RugCheck /
  Birdeye CLEAN-SCORE acceptance (a boring metadata-only mint scores clean by
  construction via `mintRugSummary`; every rug vector reddens it).
- Everything is flag-gated default-off; the money-route HTTP tests are
  unaffected (no test drives a money route over HTTP).

GATE (unchanged, human): mainnet enablement of the risky surfaces requires the
counsel sign-off + the allocation split re-confirmed + the geo/OFAC lists +
the phase-4 mainnet dry-run + ops-owned key material, all recorded in
`docs/legal/counsel-signoff.md`. The code fails closed until they are.

## UI (panel for phases 0 to 2)

`src/ui/realm_launchpad_view.ts`: pure view-core (registered in
`UI_PURE_CORES`), exact bigint vote/presale render math, the launch checklist,
and `parseAmountToBase`/`formatBaseAmount` (exact round-trip, no floats).
`src/ui/realm_launchpad.ts`: the panel on the `realm_operator.ts` template
(status page + checklist, pay-to-win banner, register form, vote panel with
tally/quorum progress bars, presale progress + contribute flow + founder
config/finalize + refund status), opened from a Token Launchpad action on each
owned realm row (host hook wired in `src/main.ts`).
`src/net/realm_presale.ts`: pure contribution-instruction builder (single
escrow leg + memo, reusing the realm_buy encoders);
`signAndSendPresaleContribution` in `src/net/wallet.ts`; launchpad REST
methods + wire types on `Api` (src/net/online.ts).

i18n: new flat English-only `launchpad` catalog domain
(`src/ui/i18n.catalog/launchpad.ts`, 130 keys) spread into
`i18n.catalog/index.ts` exactly like `realmOp`; never per-locale overlays for
the source. The five non-Latin M16 fills (zh_CN, zh_TW, ja_JP, ko_KR, ru_RU;
130 keys each) ride in the same change. Server error codes map to
`launchpad.err.*` via an exported `ERR_KEYS` table; a test pins coverage of
every server-emitted code. Generated i18n artifacts + the resolved-table hash
baseline are regenerated and committed (`npm run i18n:gen`,
`npm run i18n:hash -- --write`).

Acceptance: `tests/realm_launchpad_view.test.ts` (17 tests) green;
`tests/architecture.test.ts` (purity + UI_PURE_CORES completeness) green;
S3 guard (`tests/localization_fixes.test.ts`) green; M16
(`tests/i18n_completeness.test.ts`) green; i18n freshness gates
(`i18n_resolved_equivalence`, `i18n_status_registry`) green.

## Invariant confirmations

- Phase 3 non-custodial: the server holds NO settlement credentials. The
  transient mint keypair signs only the account creation (powerless after the
  tx: authorities rest with the founder, then nobody); the transient lock base
  keypair only namespaces the escrow PDA. Neither is persisted, returned, or
  loggable (test-pinned source scan). The founder signs and pays everything.
- Phase 3 scoped verifier: solana_token2022.ts is used ONLY by the launch
  flow; the legacy parsers (solana_rpc.ts / solana_tx.ts) are untouched and
  still hard-reject Token-2022 (re-pinned against a REAL devnet Token-2022
  transfer in the dry-run).
- Phase 3 ledger-first: launch_tx_sig and distribute_tx_sig are UNIQUE; every
  launch write is a null-column CAS so replays and races record exactly once.
- `src/sim/` purity: NOTHING was added to `src/sim/` (no mint, RPC, decimals,
  or price anywhere near it); `tests/architecture.test.ts` green.
- Server authoritative: every on-chain claim is accepted only after
  `fetchFinalizedTransaction` + the branch's own delta/memo/fee-payer parsers
  verify it (contribution AND refund), mirroring `verifyBuyPayment`.
- Non-custodial: the server pins quotes and verifies; funds move
  contributor -> founder escrow and escrow -> contributor only. No keypair,
  no signing, no settlement credentials in the presale path (test-pinned).
- SQL only in `*_db.ts`, each behind an interface (`RealmTokenDb`,
  `RealmVoteDb`, `RealmPresaleStore`) with in-memory fakes in the tests.
- Money tables ledger-first with `UNIQUE(tx_sig)`:
  `realm_presale_contributions.pay_tx_sig` UNIQUE (+ `refund_tx_sig` UNIQUE);
  nothing is granted in phases 0 to 2, so the ledger row IS the entire write.
- Untouched: realm stake escrow semantics, `usesToken2022` rejection on
  stake/buy (still hard-rejecting, re-pinned by the existing realm_buy tests
  and the new presale Token-2022 test), `TOKEN_PROGRAM_ID`,
  `server/realm_tiers.ts` (founding stays priced in $WOC).
- No em/en dashes or emojis in any new file; conventional scoped commits.

## Gate status on this branch

- `npx tsc --noEmit`: clean (also verified per intermediate commit via
  detached worktrees).
- Biome on changed files: clean (warnings only, per CI policy).
- New suites: 89 unit tests green + 9 real-Postgres integration tests green.
- Full `npm test` at the branch tip: 11570 passed, 17 failed, ALL 17 inside
  7 suites that already fail at the base merge 2bb4d5084 (verified by
  stash-and-run; the base fails 19 tests, so this branch is net -2):
  `schema_wiring` (11: its ensureSchema mock never served
  `information_schema` for the branch's own `assertRealmSchema`),
  `malware_scan` (branch keeper files + `@solana/web3.js`, the known
  category blocker), `entry_window_parity` + `mobile_window_coverage`
  (`woc-season-window`), `rate_limit_copy` (pre-existing em dashes in
  main.ts keeper comments), `characterization` `realms_get_noauth` (the
  branch's realm directory 500s with no DB at HEAD too),
  `surface_inventory` (the branch never registered its realm/affiliate/season
  routes). This branch REPAIRED the surface inventory for all realm +
  launchpad + affiliate routes (3 failing tests -> 1; the remaining diff is
  only the two `/internal/woc/season/*` arms, which cannot be inventoried
  without also registering them as RouteDefs, a pre-existing conflict between
  two guards). The 4 failures my changes introduced (i18n freshness x4) are
  fixed by the committed regenerated artifacts + hash baseline.

## Open questions surfaced

- Cap denomination semantics: caps are per-rail and the soft cap is a combined
  exact fraction sum (fully funding any one rail's soft component satisfies
  the whole target). PRD leaves multi-rail cap semantics unspecified; confirm
  or switch to a single founder-chosen quote asset before phase 4 feeds the
  curve.
- Player entry point: vote/presale panels are currently reachable from the
  OWNER dashboard (realm_operator row action). Non-owner voters/contributors
  need a public entry (realm-list integration per PRD section 9) in a
  follow-up; the routes already serve any authed account.
- Refund binding: a refund tx must carry the ORIGINAL contribution signature
  as its memo (1:1 binding). Founder tooling to batch-issue refunds does not
  exist yet; refunds are submitted per contribution via
  `POST .../token/presale/refund`.
- Presale config immutability: config is once-only and immutable; no
  cancel/extend path exists (PRD is silent). Decide before mainnet.
- Core convergence (PRD section 13): this adds the FOURTH quote/verify/confirm
  fork. Converge marketplace/realm_buy/ads/presale onto one parametric core
  before phase 3 to 6 add more surface.
- `/api/woc/season` + `/internal/woc/season/*` inventory/RouteDef debt and the
  other pre-existing red gates above belong to the base branch, not this
  feature.

## Upstream-PR recipe (when the #799/#475 chain lands)

1. Rebase this branch onto the then-current `release/**` integration base
   (`git rebase --onto <release> 2bb4d5084 feature/woc-realm-token-launchpad-impl`),
   resolving `server/db.ts` / `server/main.ts` / `server/realm_db.ts` wiring
   hunks (all additive) and re-running `npm run i18n:gen` +
   `npm run i18n:hash -- --write` (never hand-resolve generated conflicts).
2. Re-run the gate: `npx tsc --noEmit`, `npx vitest run
   tests/realm_token.test.ts tests/realm_vote.test.ts
   tests/realm_presale.test.ts tests/realm_launchpad_view.test.ts
   tests/architecture.test.ts tests/localization_fixes.test.ts
   tests/i18n_completeness.test.ts`, plus the PG integration suites with a
   throwaway Postgres 16 (`PG_TEST_URL=... npx vitest run
   --no-file-parallelism tests/realm_*.integration.test.ts
   tests/realm_launchpad_db.integration.test.ts`), then `npm run gate`.
3. Expect the pre-existing red gates above to be fixed (or explicitly waived)
   on the integration base; the malware-gate allowlist question
   (@solana/web3.js keeper imports) is the known category blocker for every
   on-chain PR.
4. Open the PR against upstream with `.github/PULL_REQUEST_TEMPLATE.md`,
   scope: phases 0 to 2 only (no mint, no chain writes, no mainnet
   dependency), and link the PRD + this file. Screenshots of the launchpad
   panel (desktop + mobile) go under `docs/screenshots` per the repo rule;
   they still need to be captured against a running dev server.
