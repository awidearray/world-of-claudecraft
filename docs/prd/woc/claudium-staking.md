# Claudium Staking: time-locked $WOC staking that yields Claudium

> **STATUS: PLAN FOR REVIEW + PHASE 0 SCAFFOLDING.** This is a written product
> spec plus the pure math and API surface stubs for review, not a live feature.
> It extends the Claudium purchase rails (`feat/woc-claudium-ui`: buy Claudium
> with Stripe, SOL, or $WOC) with a fourth acquisition path: lock $WOC for a
> fixed term and earn Claudium yield. It deliberately reuses the staking stack
> proposed in PR #3 (LP staking vault), PR #4 (fee share), and PR #5 (guardian
> flair), and the wallet-link foundation (`docs/prd/woc/wallet-link.md`).

| | |
|---|---|
| **Tier** | 2 - Economy retention loop on shipped foundations |
| **Ease** | 3/5 (no new on-chain program; new service surface + epoch runner + UI tab) |
| **Flywheel** | 4 (locks $WOC supply, daily-return habit, funnels yield into item/skin spend) |
| **Sustainability** | Sink for $WOC (locked principal), bounded faucet for Claudium (capped emission) |
| **Reg risk** | Medium. Yield on a locked token, but paid in a closed-loop, non-transferable soft currency with no cash-out. Flag-gated off until counsel review. |
| **Constraints** | Non-custodial. `src/sim/` stays pure. Game server computes no balances (service-authoritative). Graceful degradation: the game boots and plays with everything off. |

## 1. Goal: what we are building and why

Today $WOC has exactly one relationship with Claudium: you spend it. The
purchase rails convert $WOC (or fiat, or SOL) into Claudium at the oracle rate,
burn a slice, and credit the balance. That serves spenders, but it gives
holders nothing to do except hold.

Claudium Staking gives holders a productive choice: lock $WOC in a
non-custodial vault for a fixed term (30, 60, 90, 120, 180, or 360 days) and
earn a Claudium yield, accrued daily and claimable any time, at an APY that
rises with the term. The principal never moves custody: it sits in a
per-position vault only the staker's wallet can withdraw from, after the lock
expires, exactly like the LP staking vault in PR #3 (in fact, it is the same
program).

Why this is worth building:

1. **A $WOC sink that is not a burn.** Locked supply comes off the market for
   30 to 360 days at a time. Long locks (180/360) are rewarded most, so the
   sink skews durable.
2. **A daily habit.** Accrual lands once a day; claiming is a one-click reason
   to log in. Same retention shape as daily rewards, funded by holders locking
   instead of by us alone.
3. **Yield that cannot dump.** The yield is Claudium: server-authoritative,
   non-transferable, only spendable in the item/skin store. Rewarding lockers
   creates zero sell pressure on $WOC and directly feeds cosmetic spend.
4. **A holder ladder between "buy" and "LP".** The LP vault (PR #3) asks for
   DEX sophistication. This asks only "how long can you wait": a simple retail
   product on the same rails.

## 2. Decisions locked for this plan

| # | Decision | Choice |
|---|---|---|
| D1 | Early exit | **Hard lock.** Principal exits only at maturity. Enforced on-chain (`unstake` requires `now >= locked_until`); no server override, no penalty path. |
| D2 | Payout cadence | **Daily accrual, claim any time.** A daily epoch credits accrual to a claimable bucket; claiming moves it into the Claudium balance. Unclaimed accrual is never forfeited (the lock is already the commitment device). |
| D3 | Terms and APY | Six fixed terms: **30d 5%, 60d 7%, 90d 9%, 120d 11%, 180d 14%, 360d 20% APY**, paid in Claudium on the USD value of the staked $WOC. Env-tunable in basis points, clamped to a program-of-record max (50%). |
| D4 | Custody | **Reuse the PR #3 vault program** (`woc_lp_vault`) with a new pool whose stake mint is $WOC. The program is mint-agnostic (`init_pool` registers a pool for one mint); no new on-chain code, no new audit surface. |
| D5 | Who computes yield | **The economy service.** The game server proxies, exactly like every other Claudium flow. The service owns accrual state, the emission cap, and the credit. |

## 3. Player experience

In the Claudium window (the existing buy window from `feat/woc-claudium-ui`),
a new **Stake** tab:

1. Pick a term. The ladder shows each term's APY and a live per-day estimate
   at today's oracle rate for the amount typed (see the worked example in 5.2).
2. Approve one wallet transaction (quote, sign, confirm: the same
   non-custodial pattern as the $WOC purchase rail).
3. Watch it accrue. The positions list shows: locked amount, term, matures-at
   date, accrued claimable Claudium, and a **Claim** button.
4. At maturity, an **Unstake** button appears; withdrawing returns exactly the
   principal to the wallet. The position keeps accruing at its term APY until
   unstaked (post-maturity accrual continues at the same rate; see 7.4).

Everything is denominated for the player in Claudium and days. APY is shown as
"estimated, varies with the $WOC price" (see the formula in section 5).

## 4. What already exists that we reuse (do not rebuild)

On `feat/woc-claudium-ui` (this PR's base):

- `server/claudium_proxy.ts`: the typed, fail-closed client for the economy
  service. Staking adds sibling functions to this surface; the graceful
  degradation contract (typed unavailable results, never throws) is inherited.
- `server/claudium.ts`: the authenticated dispatch-core pattern
  (`handleClaudiumApi`), bearer active-guard, RouteDef registration. The
  staking API is a sibling module with the identical shape.
- `src/ui/claudium_window.ts` + `src/ui/claudium_view.ts`: the window shell and
  the pure view-core pattern the Stake tab extends.
- The oracle rate `wocBaseUnitsPerClaudium` served by the price endpoint: the
  same rate the $WOC purchase rail uses is the rate accrual is computed at.
- `server/daily_rewards.ts`: precedent for service-credited Claudium and for
  gating on wallet state (`cachedWocBalance`).
- `docs/prd/woc/wallet-link.md`: identity = game account + one verified linked
  wallet. Positions belong to the linked wallet of the acting account.

On the staking stack (PRs #3, #4, #5; branch `feat/woc-lp-staking-vault`):

- `solana/programs/woc_lp_vault`: non-custodial per-position vaults with
  `init_pool / open_position / stake / extend_lock / unstake / close_position /
  set_paused`, monotone locks, `MAX_LOCK_SECONDS = 366 days` (our longest term,
  360d, fits), and principal exit that is never gated by pause. A second pool
  on the same deployed program holds $WOC positions.
- `server/lp_staking.ts`: the pure-math-module discipline (no I/O, bigint base
  units, dust flooring, budget clamps). `server/claudium_staking_math.ts` in
  this PR is the same discipline for the Claudium yield side.
- `server/lp_staking_service.ts` / `lp_staking_db.ts` / `lp_vault_client.ts`:
  the epoch runner, Postgres position mirror, and non-custodial tx builder
  patterns Phase 2 copies.
- PR #5's guardian flair: the template for a later cosmetic staker ladder
  (explicitly a follow-up, not in scope here).

What is genuinely new:

- An economy-service surface for staking (positions, accrual state, credit),
  SDK v1 extension over the same secret-gated internal API.
- A daily epoch runner on the game server that snapshots $WOC pool positions
  and posts accrual instructions to the service.
- The Stake tab UI.

## 5. The mechanism, precisely

### 5.1 Terms

| Term | Lock seconds | APY (bps) | Key |
|---|---|---|---|
| 30 days | 2,592,000 | 500 | `d30` |
| 60 days | 5,184,000 | 700 | `d60` |
| 90 days | 7,776,000 | 900 | `d90` |
| 120 days | 10,368,000 | 1100 | `d120` |
| 180 days | 15,552,000 | 1400 | `d180` |
| 360 days | 31,104,000 | 2000 | `d360` |

The table is code-of-record in `server/claudium_staking_math.ts`
(`CLAUDIUM_STAKE_TERMS`), env-overridable per term via
`WOC_CLAUDIUM_STAKE_APY_BPS` (format `30:500,60:700,...`), clamped to
`[0, 5000]` bps. Only these six durations are valid stake inputs; the server
rejects any other lock length at quote time (the program itself allows
arbitrary locks up to 366d, the term gate is a server-side product rule).

### 5.2 Accrual formula

Once per day (the epoch), for every active position:

```
dailyClaudium = floor( stakeBase * apyBps / (wocBaseUnitsPerClaudium * 10_000 * 365) )
```

- `stakeBase`: the position's staked $WOC in base units (on-chain truth).
- `apyBps`: the APY of the term the position was opened with. Fixed at open;
  an env retune applies to positions opened after the change, never
  retroactively.
- `wocBaseUnitsPerClaudium`: the oracle rate at the epoch snapshot, the same
  rate the purchase rail quotes. Since 1 Claudium is pegged at $0.01 for
  display, dividing the stake by this rate IS the position's USD value in
  Claudium units; no second conversion exists to disagree with the buy flow.
- Oracle down at epoch time: that epoch accrues nothing and is not made up.
  The service never guesses a price (same posture as the woc purchase rail,
  which disables buying when the oracle is down).
- Dust floors to zero and is not carried (matches `splitEpochEmission`
  semantics in PR #3).

Worked example: 1,000,000 $WOC staked at 180d (1400 bps), oracle at 3,333,333
base units per Claudium ($WOC trading around $0.003 with 6 decimals):
`floor(1e12 * 1400 / (3_333_333 * 10_000 * 365)) = 115` Claudium per day, on a
position worth 300,000 Claudium ($3,000 at the peg). That is 42,000 Claudium
(about $420 of store credit) over a year: 14% of position value, as the table
advertises, and easy to check against the peg by hand, which is the point of
the formula.

### 5.3 The emission cap (the faucet is bounded)

Per epoch, the sum of all accruals is clamped to
`WOC_CLAUDIUM_STAKE_DAILY_EMISSION_CAP` (Claudium/day, env, default 0 =
accrue nothing). When the cap binds, every position is scaled pro rata
(floored), and the UI shows the effective rate. This is the soft-currency
analogue of PR #3's `epochEmissionBudget` headroom clamp: the APY table is a
target, the cap is the guarantee. Ops raises the cap deliberately as staking
adoption grows; it never floats.

### 5.4 Claim and credit

Accrual lands in a per-position claimable bucket owned by the service. Claim
(any time, any subset of positions) moves the bucket into the account's
Claudium balance through the same credit path purchases use, with an
idempotency key, so a replayed claim cannot double-credit. Claiming does not
touch the chain: yield is pure soft currency.

### 5.5 Stake, maturity, unstake

- Stake: quote (server pins term, amount, the position PDA, and a memo),
  sign (wallet builds the `open_position`+`stake` transaction), confirm
  (server verifies the finalized tx and registers the position mirror). The
  exact quote/sign/confirm shape of the $WOC purchase rail.
- The lock is `now + term.lockSeconds`, set at stake time, monotone on-chain.
- Top-ups: opening multiple positions is the supported path (up to the
  per-account cap); topping up an existing position would extend its lock
  (program semantics: a deposit never shortens the lock), so the UI steers to
  "new position" instead.
- At maturity, `unstake` returns principal to the staker's wallet; the
  position keeps accruing at its term APY until actually unstaked, so there is
  no cliff panic and no idle-but-earning-nothing state. A matured position
  counts toward the position cap until closed.

## 6. Architecture

```
browser (Stake tab)
   | same-origin /api/claudium/staking/*        (bearer auth, activeGuard)
game server: server/claudium_staking.ts         (thin dispatch, computes nothing)
   | server/claudium_proxy.ts sibling surface   (secret-gated internal API, fail-closed)
economy service (external repo)                 (positions, accrual state, cap, credit)
   ^ daily epoch runner (game server)           (chain snapshot -> accrual instruction)
   |
Solana: woc_lp_vault program, $WOC pool         (custody, locks, the only mover of principal)
```

Division of authority, unchanged from the rest of the Claudium family:

- **Chain**: owns the principal and the lock. The server can never move a
  position; there is no server key on the custody path.
- **Economy service**: owns Claudium. Accrual, cap, claimable buckets, and the
  credit are service state; the game server and client only display them.
- **Game server**: authenticates, proxies, and runs the epoch snapshot
  (read chain, post to service). Holds a Postgres mirror of positions for
  display and ops, never as the source of truth.
- **Client**: renders, and signs the one thing only it can sign.
- **`src/sim/`**: untouched. No sim system reads staking state.

Fail-closed gates, all default off:

- `WOC_CLAUDIUM_STAKING_ENABLED != '1'`: routes answer with a typed disabled
  result, the epoch runner does not boot, the Stake tab does not render.
  Server behavior is byte-identical to today with the flag off.
- Service unset/unreachable: every proxy call returns typed unavailable
  (inherited contract), the tab shows the standard unavailable state.
- `WOC_CLAUDIUM_STAKE_DAILY_EMISSION_CAP` unset or 0: positions can open but
  accrue nothing; the UI must surface this honestly ("accrual paused").

## 7. Bounding and abuse resistance

1. **Flash-stake farming**: impossible by construction. The shortest exposure
   to yield is a 30-day hard lock; there is no early exit to arbitrage.
2. **Price gaming**: accrual uses one oracle snapshot per day, the same rate
   the buy rail quotes. Intra-day wicks move at most one day of accrual.
3. **Whale monopolization**: the emission cap scales everyone pro rata, so a
   whale dilutes the APY (visibly) rather than draining a budget. Per-account
   position cap (default 10) and min stake (default $10 of $WOC at quote time,
   env) bound state growth and dust spam.
4. **Post-maturity squatting**: matured positions accrue at their term rate
   but count against the position cap, and their weight is inside the same
   global cap; a later retune can add a post-maturity decay if squatting
   becomes a real problem (open question 14.3).
5. **Sybil**: yield is proportional to stake; splitting stake across accounts
   earns exactly the same, so there is nothing to farm except position-cap
   workarounds, which only cost the sybil more rent.
6. **APY fat-finger**: env overrides clamp to 5000 bps in code; the table is
   pinned by tests.

## 8. Economy analysis: faucet, sink, and the buy rail

**$WOC side (pure sink).** Staked $WOC is locked supply: it cannot trade, LP,
or buy Claudium until maturity. Unlike the purchase rail's burn split it comes
back, but time-locked supply at 30 to 360 days materially deepens holding.
Staking competes with PR #3's LP vault for the same wallets; that is fine and
intended: LP for the sophisticated (real fee share, PR #4), terms for everyone
else, both locking $WOC.

**Claudium side (bounded faucet).** Staking is a new Claudium faucet next to
purchases and daily rewards. Three properties keep it safe:

1. The cap (5.3) makes the worst-case daily mint a config constant, not a
   market outcome.
2. Claudium is closed-loop: non-transferable, no cash-out, spendable only in
   the store. An oversized faucet can cheapen cosmetics, it cannot touch the
   token or produce sell pressure.
3. Every Claudium spent is a sink event already priced by the store; yield
   Claudium increases store throughput, which is the desired flywheel.

**Does staking cannibalize purchases?** At 20% APY (the top term), a year of
locked capital yields one fifth of the Claudium the same dollars would buy
outright, and the buyer gets it immediately. Staking never beats buying for a
player who wants Claudium now; it rewards a player who was holding $WOC
anyway. The two rails serve disjoint intents, and the cap lets ops tune the
overlap to zero if purchase revenue dips measurably.

**Emission cost accounting.** At the $0.01 peg, the cap is denominated in
cents per day of soft-currency issuance: a cap of 100,000 Claudium/day is at
most $1,000/day of store-credit issuance, a marketing spend with better
targeting than most.

## 9. Relationship to the LP staking stack (PRs #3, #4, #5)

- **Same program, parallel pool.** PR #3's vault gains a second pool whose
  stake mint is $WOC. No program change; the pools do not interact.
- **Different reward plumbing, on purpose.** LP rewards are $WOC emissions
  bounded by the flow ledger (real inflows). Claudium yield is soft currency
  minted by the service under a cap. The two never share a budget, so this
  feature does not draw down LP/arena headroom and cannot be blocked by it.
- **No ve-decay here.** PR #3 weights by remaining lock (veLP) because its
  locks are open-ended. Terms are fixed products, so APY keys off the chosen
  term for the position's whole life. Simpler to display, simpler to reason
  about, and impossible to game by lock-extension churn.
- **Flair follow-up.** A cosmetic staker ladder by term length (PR #5's
  guardian pattern: identity field, nameplate painter, refresh loop) is the
  obvious follow-up and is explicitly out of scope here.
- If PR #3 lands first, Phase 2 below is mostly configuration. If this lands
  first, we deploy the same program with only the $WOC pool initialized.

## 10. UI

Extend the Claudium window with tabs: **Buy | Stake | History** (Buy is the
existing content, untouched).

Stake tab, following the `claudium_view.ts` pure view-core pattern (a
`claudium_staking_view.ts` core, DOM-free, drives the tab; the window stays a
painter):

- Term ladder with APY and a live "about N Claudium/day" preview off the
  current oracle rate; the preview states it varies with price.
- Positions table: amount, term, opened, matures (relative + absolute),
  accrued claimable, Claim per row + Claim all.
- Matured rows swap the lock badge for an Unstake button (wallet flow).
- Service-off / flag-off: the tab renders the standard unavailable state; with
  a zero cap it shows "accrual paused".
- All strings via `t()` in the English catalog; the M16 wordy-copy rule
  applies to the explainer copy.

## 11. Regulatory posture

Locking a token for yield is the shape regulators look at; two properties
differentiate this from a financial staking product, and one gate keeps us
honest:

- The reward is a **closed-loop virtual currency**: non-transferable, no
  redemption, no secondary market, spendable only on in-game cosmetics. It has
  no market price to appreciate.
- The principal is **never pooled or deployed**: per-position vaults, no
  rehypothecation, nothing resembling a lending return. The yield is a
  marketing emission, not investment proceeds.
- Nevertheless: **default off, counsel review before mainnet enablement**,
  same posture and same flag discipline as the wager features. APY marketing
  copy avoids fiat-return framing (we display "Claudium per day", never
  "earn $X").

## 12. Phased delivery (each phase shippable)

**Phase 0 (this PR): spec + pure math + API stubs.**
`docs/prd/woc/claudium-staking.md`, `server/claudium_staking_math.ts`,
`server/claudium_staking.ts` (dispatch core, fail-closed, NOT yet registered),
`tests/claudium_staking_math.test.ts`.
Accept: tsc clean, tests green, zero behavior change (no route registered, no
flag read anywhere live).

**Phase 1: service surface + proxy + route registration.**
Economy-service endpoints (positions, accrual, claim, credit) + SDK; sibling
functions in `claudium_proxy.ts`; register the RouteDefs in
`server/http/registry.ts` and the legacy arm in `server/main.ts` (the dual-edit
invariant); wire the bearer activeGuard.
Accept: service-off returns typed unavailable on every route; proxy tests in
the pattern of `tests/player_economy_proxy.test.ts`.

**Phase 2: chain: $WOC pool + tx builders + mirror + epoch runner.**
Init the $WOC pool on `woc_lp_vault`; stake quote/sign/confirm builders
(pattern: `lp_vault_client.ts`); Postgres mirror (pattern:
`lp_staking_db.ts`); daily epoch runner posting accrual instructions with the
oracle snapshot; idempotent epochs (advisory lock + synthetic epoch key).
Accept: devnet lifecycle proof like PR #3's (stake, accrue with capped epoch,
claim credits balance, early-unstake refused on-chain, matured unstake, close).

**Phase 3: Stake tab UI.**
View core + painter + i18n + screenshots (PR template requires them).
Accept: E2E script drives stake/claim/unstake against a local service fake;
renders sanely with everything off.

**Phase 4: ops + launch.**
Admin visibility (total locked, daily emission vs cap, positions by term),
alerting on cap saturation, runbook, counsel sign-off, staged enablement
(devnet, then flag on with a small cap).
Accept: runbook + dashboards live before the flag flips anywhere real.

## 13. Risks and mitigations

| Risk | Mitigation |
|---|---|
| APY set wrong and Claudium floods the store economy | Cap is the guarantee (5.3); table clamped and test-pinned; retunes are non-retroactive |
| Oracle failure or manipulation | One snapshot/day, buy-rail-shared source, accrue-nothing on outage; never interpolate |
| Service outage during an epoch | Epochs are idempotent and re-runnable; missed epochs are visible in ops, policy decision to backfill or not is explicit (default: no backfill, matches D2 simplicity) |
| Players misunderstand the hard lock | Quote screen states the maturity date twice and requires a checkbox; no countdown dark patterns; History shows the lock terms forever |
| Regulatory reframing of "staking" | Section 11 posture; copy review; flag default off; per-jurisdiction geo gate available if counsel requires it (same machinery as wager features) |
| Program pause vs principal | Inherited from PR #3: pause blocks new stakes, never unstake; document in the runbook |

## 14. Open questions

1. **Auto-roll at maturity?** A "restake for the same term" toggle is pure
   retention upside but complicates the mental model of D1. Proposed: v2.
2. **Should staked $WOC count for holder gates?** Daily-rewards min-holdings
   and holder flair currently read wallet balance; a locked position arguably
   should count (it is stronger holding). Proposed: yes, in Phase 2, by adding
   the position mirror to `cachedWocBalance`'s sources; needs a decision.
3. **Post-maturity accrual decay** (see 7.4): keep full-rate, or decay to the
   30d rate after N days unclaimed? Proposed: ship full-rate, monitor.
4. **Term keys as flavor names** (the LP vault ships drift/ripple/tide/...):
   cosmetic naming for terms can come with the flair follow-up; scaffolding
   uses `d30..d360`.
5. **Cap governance**: who owns raises of the daily emission cap, and is the
   value public? Proposed: ops-owned env, value displayed in the admin
   dashboard only.

## 15. Out of scope (this plan)

- Any change to the purchase rails, SKU ladder, burn split, or peg.
- $WOC-denominated yield, fee share, or anything flow-ledger-funded (that is
  PRs #3/#4's lane).
- Cosmetic staker flair (follow-up on the PR #5 pattern).
- Realm-token staking (per-realm currencies are the launchpad's lane).
- Mobile-specific wallet UX beyond what the existing purchase rail already
  handles.
