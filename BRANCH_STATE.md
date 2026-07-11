# Branch state: feature/woc-realm-token-launchpad-impl

Realm Token Launchpad, phases 0 to 5 of
`docs/prd/woc/realm-token-launchpad.md`, implemented on the #475 realm base
freshened with release/v0.23.0 (merge 2bb4d5084). Deliverable is this pushed
branch; NO upstream PR yet (the #799/#475 chain is blocked, see the recipe at
the bottom). Phases 3 (mint factory + locks), 4 (bonding curve + DAMM v2
graduation), and 5 (fee keeper + revenue split) are recorded below the phase
0 to 2 record.

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

## Phase 3: Token-2022 mint factory + allocation/locks

Files: `server/realm_token_alloc.ts` (pure allocation + vesting math:
env-resolved bps with hard caps founder 1500 / levy 1000 / treasury 1500 /
liquidity 2000, public bucket = exact remainder with a 4000 floor by
construction; exact supply split with the remainder into the public bucket;
Jupiter Lock schedules founder 12+36, levy 12+48 strictest, treasury 6+24,
every locked base unit accounted), `server/token2022_verify.ts` (the SCOPED
Token-2022 verifier alongside the untouched legacy gates:
`parseRealmTokenPayment` accepts ONLY Token-2022 balances of the given mint,
the exact inverse of parseSplitPayment, pinned side by side in tests; a
jsonParsed mint decoder for authorities/supply/extensions; the Jupiter Lock
`VestingEscrow` decoder with the layout pinned from jup-lock
`programs/locker/src/state/vesting_escrow.rs` behind the Anchor
discriminator), `server/realm_token_mint.ts` (the factory: prepare builds ONE
create-mint tx in the boring metadata-only profile, 9dp, freeze null, metadata
pointer to self with a NULL pointer authority, partial-signed by a TRANSIENT
mint-account keypair that is discarded in-call; the FOUNDER is fee payer AND
mint authority so the server never holds an authority key; confirm fetches the
finalized tx + live mint state and records mint + `launch_tx_sig` UNIQUE;
verify checks EVERYTHING on-chain: exact supply, renounced mint authority, and
per lock the recipient/amount/immutability (cancelMode 0 + updateRecipientMode
0)/token-program flag/untouched state/schedule floors (including the
backdated-cliff attack: cliffTime is checked against NOW, not the escrow's own
vestingStartTime)/escrow funding; `launchReadyToList` + `listRealmToken` gate
`funded -> live` on verified locks AND a curve). DB: `realm_token_launches`
(NUMERIC(30,0) supply, alloc snapshot, recipients, lock addresses,
`mint_confirmed_at` / `locks_verified_at`) in realm_token_db.ts with an atomic
two-table `recordMintCreated` transaction; `assertRealmSchema` extended.
Routes: `GET .../token/launch`, `POST .../token/mint/prepare|confirm`,
`POST .../token/launch/verify` (rate-limited on every RPC-touching arm),
inventoried in the surface ledger. Client: `signAndSendServerTransaction`
(wallet co-signs the server-built partial-signed tx UNMODIFIED),
launch REST methods + wire types on `Api`, the launch panel section (economics
table, step ladder, mint-create + lock-verify founder flows, per-check
proof checklist with Solscan links) on the pure `launchView` core, the
`launchpad.launch.*` i18n keys + five non-Latin M16 fills.

Dependency added: `@solana/spl-token` 0.4.15 + `@solana/spl-token-metadata`
0.1.6 (sanctioned by the handoff for phase 3; used only by the mint factory).

Acceptance:
- `tests/realm_token_alloc.test.ts` (15): allocation caps reject (never
  clamp), exact 10000 sum, split sums exactly at adversarial supplies,
  schedule totals exact, levy strictest.
- `tests/token2022_verify.test.ts` (9): scoped-parser inverse gate pinned
  against parseSplitPayment on the same fixture; mint decoder surfaces
  rug-vector extensions; VestingEscrow layout round-trip + discriminator
  rejection + past-2^53 u64 exactness.
- `tests/realm_token_mint.test.ts` (14): the partial-signed tx shape (founder
  slot open, mint slot signed, 4 instructions), every prepare/confirm guard,
  every broken-lock property fails closed without stamping (12 mutation
  cases), signature replay across realms, listing blocked without locks AND
  without a curve, re-verify reads pinned addresses.
- Real Postgres 16: `tests/realm_launchpad_db.integration.test.ts` extended
  (+2: launch pipeline atomicity/immutability/replay + drop-column boot fail),
  11 green, `realm_db.integration.test.ts` 13 green.
- `tests/realm_launchpad_view.test.ts` extended (launchView ladder + ERR_KEYS
  coverage of all 23 new server codes); architecture + S3 + M16 + i18n
  freshness suites green; tsc clean; biome clean on changed files.
- Surface inventory: the 4 new routes classified; the only remaining
  surface_inventory diff is the pre-existing `/internal/woc/season/*` debt.

Phase 3 gate status: the PRD acceptance devnet dry-run (mint created on devnet
+ RugCheck-clean) is BLOCKED in this environment: `SOLANA_DEVNET_DEPLOYER` is
ops-owned key material (root CLAUDE.md) and is not present. Everything
chain-side is exercised through the injected `LaunchChainReader` fixtures; the
dry-run should run before enabling the routes anywhere real (the factory is
additionally fail-closed on `LEVY_FUND_WALLET`, unset by default).

## Phase 4: bonding curve + DAMM v2 graduation (Launchpad seam)

Files: `server/realm_launchpad.ts` (the thin `Launchpad` interface: partner
config read, pool creation, curve state, graduation state; a Raydium adapter
is a drop-in sibling), `server/realm_launchpad_dbc.ts` (the ONLY module that
imports the Meteora SDKs: `@meteora-ag/dynamic-bonding-curve-sdk` 1.5.10 +
`@meteora-ag/cp-amm-sdk` 1.4.4; every read maps failure to null, the one
builder partial-signs with a transient base-mint keypair). Two hosts behind
`realmLaunchpadHost()` (flag-gated OFF by default via
`REALM_LAUNCHPAD_ENABLED`):

- `meteora-dbc`: partner config read LIVE on every decision (quote mint, fee
  claimer, migration threshold, LP-lock percentages: never hardcoded, pinned
  by test that the threshold flows from the injected config read). Listing
  requires the config's STRUCTURAL guarantees (`configGuaranteeIssues`): DAMM
  v2 migration, partner+creator permanent-locked LP at or above
  `REALM_LP_LOCK_MIN_BPS` (default the full 10000), a locked-vesting schedule
  (the DBC creates it through the Jupiter Locker program at migration), and a
  real threshold. Pool creation: the DBC program mints the token itself (the
  SDK's createPool; base mint signs), so the founder co-signs the server-built
  partial-signed tx; confirm verifies the pool ON-CHAIN under OUR config with
  the founder as creator, records mint + curve + per-realm fee-claimer PDA
  (`realmFeeClaimerPda`, a PDA of the realm escrow program, never an EOA) and
  flips funded -> live. Graduation: curve reports migrated AND the live DAMM
  v2 pool's permanentLockLiquidity share is at/above the floor -> live ->
  graduated with pool + lock proof addresses pinned.
- `fixed-rate-stub` (the PRD's devnet fixed-rate stub host): REFUSES mainnet,
  lists the phase 3 pre-minted token only through the phase 3 gate (mint
  confirmed + all three Jupiter Locks verified on-chain), never graduates.

DB: `recordCurveListed` (guarded: no curve yet, funded, mint NULL-or-match)
and `recordGraduation` (guarded CAS live -> graduated) in realm_token_db.ts.
Routes: `GET .../token/curve`, `POST .../token/curve/prepare|confirm`,
`POST .../token/curve/graduation`, all rate-limited, inventoried, classified.
Client: curve Api methods + wire types, the curve panel section (live
migration progress bar against the on-chain threshold, LP-lock share line,
Solscan proof links, open-curve / verify-listing / verify-graduation founder
flows), `curveView` pure core, `launchpad.curve.*` i18n + five non-Latin M16
fills, 14 new error codes mapped in ERR_KEYS and pinned by the coverage test.

Acceptance:
- `tests/realm_launchpad_curve.test.ts` (22): exact progress math at the
  boundaries; every structural guarantee flags; host factory OFF by default
  and each selection path; stub refuses mainnet + requires the pre-minted
  token + never graduates; Meteora adapter rejects pre-minted tokens and
  foreign-config pools; stub listing runs the phase 3 verified-locks gate;
  Meteora listing verifies pool binding (missing pool / foreign creator / bad
  mint all rejected); graduation only when migrated AND fully
  permanent-locked (partial lock rejected), double-graduation matches nothing.
- `tests/realm_launchpad_view.test.ts` extended (curveView + the 14 new
  codes); tsc clean; server esbuild bundle builds WITH the Meteora SDKs;
  architecture + S3 + M16 suites green; biome clean on changed files.

Phase 4 gate status: the PRD acceptance is a MAINNET dry-run (curve trades,
migrates at threshold, LP provably locked) that requires the owner's explicit
sign-off; not run here, and the whole surface ships default-off. Owner
decisions surfaced for that dry-run: (1) launch-mode sequencing: on the DBC
host the program mints the token, so the phase 3 factory path (pre-mint +
three jup-locks before listing) applies to the stub/self-hosted mode, while
DBC-native launches get their guarantees from the config (locked vesting =
the founder bucket; LP permanently locked); the levy + treasury buckets for
DBC-native launches must come from post-migration leftover withdrawal locked
via phase 3's verifyLaunch, or from partner fee share (phase 5): confirm the
preferred shape before mainnet. (2) The partner config itself is created by
platform ops with their own key (the SDK's partner.createConfig): the
feeClaimer recorded there is ops-owned; the per-realm PDA identity is stored
on realm_tokens.fee_claimer_pda for phase 5 attribution.

## Phase 5: realm-token fee keeper + revenue split

Files: `server/realm_fee_keeper.ts` (PURE orchestration + split math: treasury
and buyback legs floored, the affiliate cut carved out of the operator's GROSS
share at the realm's attributed bps, the operator absorbs every remainder so
the four legs sum to exactly the claim; env caps treasury/buyback 5000 each
with a combined 8000 cap so the operator floor is 2000 bps; per-quote-asset
claim thresholds so dust never burns tx fees), `server/realm_fee_db.ts`
(the `realm_fee_claims` ledger: LEDGER-FIRST rows with `claim_tx_sig` UNIQUE
written before broadcast and `distribute_tx_sig` UNIQUE, the split legs PINNED
on the row so recovery executes the recorded ledger and a later affiliate
change can never rewrite a recorded claim; `listFeeTargets` = live/graduated
tokens with a curve), the live gateway in `realm_launchpad_dbc.ts`
(`liveRealmFeeGateway`: reads `partnerQuoteFee` off the pool state, builds +
signs the SDK's `claimPartnerTradingFee` with the ops-owned fee-claimer key,
quote fees only; measures what actually arrived via the finalized-tx delta
parsers, native measured net of the tx fee so it never over-distributes;
builds the one distribution tx: native transfers, or ATA-idempotent +
TransferChecked legs), and `withRealmFeeKeeperLock` (advisory key WOC\x05) in
payout_db.ts. Boot wiring in main.ts mirrors the buyback keepers: in-process
single-flight + the cross-process advisory lock, fail-closed unless the
claimer secret + treasury wallet + REALM_BUYBACK_VAULT are all set. The
buy-and-burn leg lands in the EXISTING realm buyback vault whose #475 keeper
swaps + burns it (the pluggable terminal step: this keeper never swaps).
Fail-closed everywhere: no operator wallet -> the pool is skipped BEFORE any
claim (fees stay accrued on-chain); unreadable config -> the cycle skips.

Acceptance:
- `tests/realm_fee_keeper.test.ts` (17): exact split sums at adversarial
  amounts with hostile affiliate bps clamped; env caps + the operator floor;
  the full claim -> distribute happy path with the exact four legs broadcast;
  affiliate folding when unattributed; the native fee reserve deducted before
  splitting; skips (threshold / unlinked operator / dark config); reverted
  claims failed with fees left on-chain; recovery strictly by recorded
  signature (claim recovered without re-claiming, distribution re-issued from
  the PINNED legs not a recomputation, landed distributions confirmed without
  re-send, replayed claim signature never tracked twice, no new claims while
  one is in flight: the no-double-spend acceptance).
- Real Postgres 16: the fee-claim ledger round-trip (sig-anchored intent, ON
  CONFLICT replay swallow, NUMERIC past-BIGINT amounts, open-claim reads,
  broadcast stamps) in the integration suite (12 green).
- assertRealmSchema extended to realm_fee_claims; tsc clean; server bundle
  builds; biome clean. Dependency added: bn.js 5.2.5 (explicit; the SDK's
  claim API takes BN amounts).

Phase 5 gate status: exercised end-to-end against the injected gateway/store
fakes plus real Postgres; a devnet/mainnet drain of a real seeded pool rides
the phase 4 dry-run gate (owner sign-off) since it needs a live DBC pool
under the partner config.

## Invariant confirmations

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
