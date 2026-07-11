# Society Trial Tokenomics: Claudium, $WOC, and the Onboarding Economy

> **STATUS: DESIGN FOR REVIEW.** This is the economic design for trialing a digital society inside World of ClaudeCraft. Nothing in this document is live. Every real-money surface it describes inherits the repo's existing rails: flag-gated default-off, non-custodial, geo/counsel gates before mainnet enablement.

| | |
|---|---|
| **Tier** | 5 - Society trial (stacks on Tiers 0-4) |
| **Flywheel** | Fun -> Retention -> Earned currency -> Community -> Optional graduation to on-chain |
| **Sustainability** | Revenue-capped emission (extends the flow-ledger invariant) |
| **Reg risk** | Low (Phase A-B) rising to High (Phase C-D); phase-gated accordingly |
| **Constraints** | Cosmetic-only / no pay-to-win on the canonical realm - non-custodial - `src/sim/` stays pure - earn-first onboarding, purchase never required |

Written 2026-07-11. Companion to `docs/prd/woc/gamefi-overview.md`, `docs/prd/woc/wallet-link.md`, and the realm token launchpad PRD (`docs/prd/woc/realm-token-launchpad.md` on the launchpad branch, [PR #7](https://github.com/awidearray/world-of-claudecraft/pull/7)).

---

## 1. Purpose and thesis

The trial's question: can a game economy onboard people who have never held digital currency, and grow them into a self-sustaining digital society, without exploiting them?

The thesis: **the game is the onramp, not the pitch.** People who have no access to digital currency do not arrive wanting a wallet; they arrive wanting to play. The economy must therefore be shaped so that:

1. The first weeks are pure game: earn a soft currency (Claudium) by playing, spend it on things that make the game more fun (items, weapons, cosmetics, guild goals).
2. The on-chain layer ($WOC and realm coins) is a graduation, not a gate. It is opt-in, celebrated, educated, capped, and never required for any gameplay.
3. The society layer (guilds, realm communities, public goods, reputation) gives players reasons to stay and build together that are not denominated in money at all.

Success is measured in retention, participation breadth, and economic health, never in token price. Section 10 defines the numbers.

## 2. Principles (non-negotiable)

These six rules shape every mechanic below. They are the difference between a durable society and an extraction scheme, and they are especially binding because the target population is financially inexperienced.

1. **Design for volatility, not "up only."** $WOC is a volatile asset. It may appreciate dramatically; it may also fall 90 percent. No gameplay system, price, reward, or promise may depend on appreciation. All gameplay pricing is denominated in Claudium or copper. Anything $WOC-quoted goes through the oracle/valuation design already specified for the launchpad (Pyth SOL/USD with confidence band, Jupiter Price v3 batched with cross-check, rolling median). The canonical failure to avoid is Axie Infinity's SLP (2021-22): an economy whose faucets were funded by new-player inflow, which required perpetual growth, and which collapsed on exactly the low-income players it had onboarded. Section 8 carries the scenario table.
2. **Every $WOC faucet is revenue-capped.** The gamblefi core (upstream #799) already makes one rule mechanical: *a season can never pay out more $WOC than it verifiably took in* (stakes, fees, burns, on-market buybacks, recorded in the flow ledger, serialized so concurrent payouts cannot overspend). This trial extends that invariant to every earning mechanic it introduces. Emissions are funded by verified revenue (market rake, ad revenue from [PR #1](https://github.com/awidearray/world-of-claudecraft/pull/1), cosmetic sales, arena rake), never by new-buyer inflow. An unfunded faucet pays approximately zero; that is the cap working, not a defect.
3. **Earn-first onboarding; purchase never required.** New players start entirely in Claudium, earned by playing. There is no purchase gate anywhere in the funnel, no fiat onramp in the trial, and no mechanic that makes a newcomer feel behind for not buying.
4. **The bridge is one-way, and power never crosses it.** During the trial the canonical realm has **no hard-to-soft bridge**: Claudium cannot be bought with $WOC or any money, only earned. (If a bridge is ever enabled post-trial, bridged Claudium is restricted to cosmetic and convenience SKUs so no-pay-to-win holds transitively.) In the other direction, **soft-to-hard convertibility is never promised**: no fixed exchange rate, no cash-out guarantee, no redemption. This is simultaneously the sustainability firewall (no implicit peg to defend) and the regulatory firewall (no security-like claim, no money-transmission posture).
5. **Newcomer protection.** Accounts carry graduation gates: tenure plus completed literacy quests before any on-chain surface unlocks; cooling-off delay on first on-chain actions; per-account caps on early activity; zero exposure to wagering/gambling-adjacent mechanics (upstream #478/#479) until well past graduation, and those remain jurisdiction-gated for everyone. Scam-awareness education is a rewarded quest line, not a wall of text.
6. **Preserve the repo's bright lines.** Non-custodial everywhere (the server verifies, never signs for users, never pools funds). `src/sim/` never sees a mint, an RPC, or a price. Cosmetic-only on the canonical realm; power realms are opt-in clones under the launchpad's `monetization_policy`, labeled and gated. Everything ships flag-gated default-off with geo (OFAC SDN + IP) and counsel gates before mainnet enablement.

## 3. The currency stack

Four layers, each with a distinct job. Lower layers never depend on upper layers.

| Layer | Currency | Ledger | Job | Who touches it |
|---|---|---|---|---|
| 0 | Copper / silver / gold | In-sim, per character | The gameplay loop's own economy: mob drops, quest rewards, vendors, auction house, player trade | Everyone, from minute one |
| 1 | **Claudium** (CLM) | Off-chain, per account, server-authoritative | The engagement economy: earned by playing, spent in the boutique (items, weapons, cosmetics), guild goals | Everyone, from session one |
| 2 | **$WOC** | Solana SPL, self-custodied | Reserve and status asset: cosmetic flair, governance weight, staking status, the common denominator for realm coins | Opt-in graduates only |
| 3 | Realm coins | Solana (Token-2022 via launchpad) | Community formation: each sub-community's own currency, launched against $WOC with anti-rug locks | Communities that earn a launch |

### Layer 0: copper (unchanged)

The existing closed loop stays exactly as it is: `MARKET_CUT = 0.05` on the auction house as the primary sink (`src/sim/sim.ts`), vendor pricing bands per `docs/design/master-spec.md`, quest `copperReward` faucets, 100 copper = 1 silver, 10,000 = 1 gold. The sim remains pure and deterministic. Nothing in this document reaches into it; the one eventual touch point (Phase 7 currency re-skin on power-realm clones) already keeps the sim seeing only an opaque `copper` balance.

### Layer 1: Claudium

Claudium is the trial's workhorse and the newcomer's entire monetary world for weeks. It follows the architecture already proven on the feature branches: balances and grants live in the external economy service (`levy-street/woc-daily-rewards-service`), consumed by the game server through the secret-gated, graceful-degradation proxy pattern (`server/claudium_proxy.ts`, mirrored by [PR #6](https://github.com/awidearray/world-of-claudecraft/pull/6)'s player-economy proxy). The game boots and plays with the service off.

**Faucets** (all server-authoritative, all bot-gated by the existing session/auth layer):

| Faucet | Amount (CLM) | Cadence | Notes |
|---|---|---|---|
| First-session quest chain | 150 total | Once | Guarantees a meaningful balance in the first hour |
| Daily reward | 20, streak-escalating to 50 | Daily | The habit anchor; streak resets soften to the prior tier, never to zero (punitive resets churn newcomers) |
| Weekly quest board | 100 | Weekly | Rotating objectives across zones, dungeons, arena participation |
| Arena participation | 5 per match, 15 per win | Capped 10 matches/day | Participation pays; this is not a wager and stakes nothing |
| Seasonal events | 100-300 | Per event | The "good times" surface: festivals, world bosses, Vale Cup style tournaments |
| Learn-and-earn quests | 25 per module, 6 modules | Once | Section 6; the only faucet tied to the graduation track |
| Mentor bounty | 50 per mentee milestone | Capped 4/week | Paid to veterans when a sponsored newcomer hits day-7 retention and first guild join |

Daily earn cap across all faucets: **100 CLM** (events and one-time grants exempt). Median new player affords the first boutique weapon (300 CLM) on day 3-4. That pacing is deliberate: the first purchase should feel earned, and a 3-day horizon builds the return habit.

**Sinks:**

| Sink | Price band (CLM) | Notes |
|---|---|---|
| Boutique weapons and armor | 300-1,200 | Under the power ceiling below |
| Cosmetics (dyes, effects, titles) | 50-2,000 | The long-tail sink; deep catalog, no power |
| Consumables (XP warmers, feast food) | 10-40 | Convenience only, capped potency |
| Guild hall upgrades | 500-5,000 from guild treasury | Section 7; the collective sink |
| Market listing extensions, name changes, character slots | 25-200 | Quality-of-life |
| Event entry cosmetics/wearables | 20-100 | Seasonal, FOMO-light: reruns are promised |

**The power ceiling.** Claudium buys weapons and gear, as required, but boutique combat gear caps at the "rare" quality tier and at item budgets below the best dungeon drops in each level band (the catalog already encodes this: `quality` and stat budgets in `src/sim/content/items.ts`). Top-tier power comes only from playing. Because Claudium is earn-only on the canonical realm (Principle 4), buying gear with it is progression, not pay-to-win; the ceiling additionally guarantees that even a future bridge cannot make money outrank play.

**Health target.** Sinks should consume 60-80 percent of issuance by the week-4 cohort (measured as sunk CLM / earned CLM per cohort). Below 50 percent, prices are too high or sinks too thin (inflation risk: balances pile up and the first purchase stops feeling meaningful); above 90 percent, earning feels like a treadmill. The dashboard (Section 10) tracks this weekly and pricing is tuned by data, not vibes.

### Layer 2: $WOC

$WOC's role in the society is **reserve and status, not gameplay money**:

- **Status and identity:** holder cosmetic flair and mounts (already built on the feature branches, per `docs/prd/woc/holder-cosmetic-flair.md`), Liquidity Guardian tiers ([PR #5](https://github.com/awidearray/world-of-claudecraft/pull/5)) with their tenure-based anti-flash-staking design.
- **Governance weight:** realm launch votes, weighted by verified $WOC at cast time, one vote per linked wallet (launchpad phase 1, shipped in [PR #7](https://github.com/awidearray/world-of-claudecraft/pull/7)).
- **The common denominator:** realm coins launch against $WOC, presales accept it, per-realm revenue splits buy-and-burn it (launchpad phases 2 and 5). Demand for $WOC grows with the number of communities, which is demand from *activity*, the only kind worth designing for.
- **Earning it:** only through the revenue-capped season mechanics (upstream #480 semantics: leaderboard rewards paid from what rake and buybacks actually pulled in), with the recipient-side anti-dump levers already specified: vesting, hold-to-earn multipliers, non-liquid trophy headline prizes.

Explicitly NOT $WOC's role: buying gameplay power anywhere on the canonical realm, gating any content, or being the unit of account for anything a newcomer sees in their first weeks.

### Layer 3: realm coins

The launchpad is the sanctioned path for sub-communities to form economies, and its design is adopted wholesale rather than re-derived: launch vote -> non-custodial presale (SOL/USDC/$WOC, per-wallet caps, soft-cap refund) -> Token-2022 mint with renounced authorities -> bonding curve graduating to permanently locked liquidity -> per-realm revenue split (operator / treasury / affiliate / $WOC buy-and-burn). Allocation: 60 percent public curve, 10 liquidity permanently locked, founder 12 (12-month cliff + 36 linear, immutable), Levy fund 8 (display-only, no share token, no redemption), treasury 10. A token cannot go live until all locks are verifiably on-chain.

For the society trial the important properties are: honest-by-construction community currencies (the anti-rug commitments are physical, not promised), $WOC as the base pair (the "common denominator" requirement), and the labeling regime (cosmetic default; power realms opt-in, labeled, geo-gated, counsel-gated) that keeps experimental community economies from leaking pay-to-win back into the canonical realm.

## 4. The onboarding funnel

Six stages. Each stage has a trigger, a payoff, and a conversion metric. The funnel's law: **every stage must be worth staying at forever.** A player who never graduates past stage 4 is a fully successful outcome; graduation is offered, never pushed.

| Stage | What happens | Payoff | Metric |
|---|---|---|---|
| 1. Play | Browser game, no download, minimal signup | Fun in under 5 minutes | D1 retention |
| 2. First Claudium | Session-1 quest chain pays 150 CLM with celebration UI | "I have money I made" | Percent earning CLM in session 1 (target: greater than 90) |
| 3. First purchase | Boutique unlocks at level 5; first weapon affordable day 3-4 | "I chose something and own it" | Days-to-first-purchase median; D7 retention |
| 4. Habit and belonging | Daily streaks, weekly board, guild join prompts at level 8 | Routine plus community | D30 retention; guild-join rate |
| 5. Graduation (opt-in) | After 14+ days tenure AND completed learn-and-earn track: the "vault" milestone. Wallet link via the existing sign-to-link flow; first on-chain cosmetic claimed gasless (fee-sponsored, still non-custodial) | A celebrated rite of passage, a badge, a cosmetic that is verifiably theirs on-chain | Voluntary link rate among eligible; literacy completion rate |
| 6. Citizenship | Governance votes, staking status tiers, realm-coin participation, mentoring | Standing in the society | Vote participation; mentor sign-ups; realm-presale breadth |

Notes on stage 5:

- The existing wallet-link flow (Reown AppKit, sign-to-link, one verified wallet per account, implemented v0.11) is the mechanism. For the target population, the doc flags one net-new proposal for evaluation: an **embedded non-custodial wallet option** (passkey-based) so a first-time user does not need to install a browser extension before their first claim. Decision deferred to Phase B; the trial can start with extension wallets and measure the drop-off that motivates (or does not motivate) the addition.
- **Gasless first claim:** the sponsor pays network fees for the first cosmetic claim only. Sponsorship is a fixed per-account, one-time subsidy (an acquisition cost, not an ongoing liability), and custody is unaffected.
- The cooling-off rule: the first on-chain action beyond the sponsored claim (e.g., a presale contribution) is available no earlier than 7 days after wallet link, with per-wallet caps inherited from the presale design.

## 5. The society layer

Money alone does not make a society; the trial funds and measures the structures that do.

- **Guild treasuries (net-new proposal, the identified gap).** Guilds currently have no shared-funds concept (`server/social.ts` has ranks, chat, rosters only). Proposal: a shared Claudium pool per guild; members contribute voluntarily (tracked, surfaced on the roster), officers spend through a two-officer approval on amounts above 500 CLM; spends target guild hall upgrades, guild-wide event entries, and guild cosmetics (tabards, hall decor). The treasury is the trial's laboratory for collective financial decision-making with training-wheels money, exactly the skill the target population is here to build.
- **Public goods.** Two instruments: the Levy Street Fund as designed (display-only portfolio, no share token, no redemption, no buy/sell controls; the securities bright line from the launchpad PRD section 8 is restated, not renegotiated), and a **world-improvement pool**: a fixed share of market rake and event revenue, allocated each season by an all-player vote (one account, one vote, tenure-weighted, deliberately NOT holdings-weighted) across a slate of world improvements: new event reruns, new boutique categories, a new dungeon wing. The society learns budgeting on things everyone can see.
- **Reputation is not wealth.** A contribution ledger per account: quests completed, dungeons cleared, events attended, mentees graduated, votes cast. Standing tiers computed from contribution, displayed alongside (never below) holdings-based flair. Plutocracy is the default failure mode of token societies; the counterweight has to be structural, not aspirational.
- **Mentorship.** Veterans opt in as mentors; the system pairs them with consenting newcomers; the mentor bounty (Section 3) pays on the mentee's *retention* milestones, not on their spending, so the incentive is to make the game fun, not to shill.

## 6. Learn-and-earn: the literacy track

Six modules, each a playable quest paying 25 CLM, gating stage-5 graduation:

1. What a wallet is (and what "non-custodial" means: the game can never take your things).
2. Keys and seed phrases: what they unlock, why no one legitimate ever asks for them.
3. Scams live here: impersonation, fake links, "double your coins," urgency pressure. The quest is a simulated scam gauntlet; spotting all the tells pays the reward.
4. Volatility: a playable market simulation where the price of a pretend asset moves; the lesson that price can halve is experienced, not asserted. Includes the sentence this document holds as policy: *no one, including us, knows where any coin's price goes.*
5. Fees, transactions, finality: why actions on-chain are slow, cost something, and cannot be undone.
6. Your rights here: what the game promises (non-custodial, no cash-out guarantee, where the ledger is public) and where to report abuse.

Modules pay Claudium, never $WOC: education must never be a speculation funnel. Content ships in the flat English-only i18n catalog with the standard fills, like every other domain.

## 7. Volatility and risk management

The scenario table the design must survive:

| Scenario | Effect on gameplay | Effect on trial | Mitigations in force |
|---|---|---|---|
| $WOC rises 10x | None: no gameplay price is $WOC-denominated | Status cosmetics appreciate socially; presale caps and vesting damp speculative rush; governance whale-weighting bounded by one-vote-per-wallet plus tenure gates | Oracle bands, per-wallet caps, vesting, contribution-based standing |
| $WOC falls 90 percent | None: same reason | Leaderboard $WOC rewards shrink with revenue (the cap working); Claudium loop untouched; society mechanics (guilds, votes, events) unpriced | Revenue-capped emission, no implicit soft-to-hard peg to defend, treasury policy below |
| Realm coin rugs or fails | Contained to that realm's cosmetics | Reputational, so the launchpad's physical locks exist precisely to prevent it; failed presales refund via the soft-cap path | Locked LP, renounced authorities, immutable vesting, refund path |
| Claudium inflation (faucet/sink drift) | First purchase stops feeling meaningful | Retention decay | Weekly faucet:sink dashboard, tunable prices, earn caps |

Treasury policy for any operator-held funds: majority stables/SOL for operating runway, no leverage, no yield-farming of user-adjacent funds, published quarterly. The trial makes no market in $WOC and defends no price, in either direction.

## 8. Trial phases, gates, and kill switches

Each phase ships flag-gated default-off, has explicit go/no-go metrics, and can be halted independently. A halt freezes new entry to the halted surface, never confiscates: balances and owned assets persist (non-custodial assets cannot be confiscated by construction).

| Phase | Weeks | Ships | Chain surface | Go/no-go to advance |
|---|---|---|---|---|
| **A: Soft-currency society** | 0-4 | Claudium faucets/sinks/boutique, funnel stages 1-4, guild treasuries, contribution ledger, dashboard | None | D7 retention at or above 25 percent; faucet:sink in 60-80 band; no bot epidemic (flagged accounts under 2 percent) |
| **B: Graduation** | 4-8 | Learn-and-earn track, vault milestone, wallet link + gasless cosmetic claim, embedded-wallet decision | Read-only + sponsored claims | At or above 20 percent of eligible accounts voluntarily link; literacy completion at or above 80 percent among linkers; zero custody incidents |
| **C: Revenue-capped earning** | 8-16 | Seasonal leaderboard $WOC rewards (upstream #480 semantics) funded by verified rake/ad/cosmetic revenue; vesting on payouts | Emissions via flow ledger | Emissions coverage at or above 100 percent every season (structural); wealth Gini below alert threshold; scam-report rate flat or falling |
| **D: Community coins** | 16+ | First realm-coin launch through the launchpad (vote -> presale -> locked launch), $WOC base pair | Full launchpad path | Presale breadth (unique contributors) prioritized over raise size; all launchpad phase-8 gates (OFAC/geo, counsel, RugCheck-clean) already satisfied |

Human gates that cannot be coded around, inherited from the launchpad handoff: mainnet dry-runs need owner sign-off; counsel sign-off recorded before any mainnet enablement; key material is ops-owned and never committed.

## 9. What this trial deliberately does not do

Stated once, bluntly, because the target population deserves it in writing:

- No promises of price appreciation, anywhere, ever, including in marketing. "Expected to grow" is a hope some holders have; it is not a mechanic, and this economy does not require it.
- No guaranteed soft-to-hard conversion, no cash-out rate, no redemption, no yield promises.
- No purchase requirement, no fiat onramp during the trial, no pay-to-win on the canonical realm (transitively enforced, Section 3).
- No custody: the server verifies on-chain claims and never holds user funds or keys.
- No wagering exposure for newcomers: GambleFi/championship-entry mechanics stay behind tenure, literacy, and jurisdiction gates regardless of this trial's phases.
- No dark patterns targeting the inexperienced: no countdown-pressure purchases, no punitive streak wipes, no social-pressure spending prompts. Retention comes from the game being good.

## 10. Measurement: the society dashboard

Sourced from the existing per-player `RewardCounters` telemetry (`src/sim/types.ts`), the flow ledger, and the economy service. Reviewed weekly during the trial; alert thresholds page a human.

| Metric | Definition | Healthy band | Alert |
|---|---|---|---|
| Retention D1/D7/D30 | Standard cohort retention | 40/25/12 percent (browser-MMO baseline) | Two consecutive weekly declines |
| Faucet:sink ratio | Sunk CLM / earned CLM, per weekly cohort at week 4 | 0.6-0.8 | Outside band two weeks running |
| Claudium velocity | Median days from earn to spend | 2-7 days | Rising trend (hoarding = thin sinks) |
| Wealth Gini (CLM) | Gini across active accounts' balances | Below 0.65 | Above 0.75 |
| Graduation rate | Voluntary wallet links / eligible accounts | Above 20 percent | N/A (informational; low is a UX signal, not a failure of players) |
| Literacy completion | Modules completed / started | Above 80 percent | Below 60 |
| Emissions coverage | Verified season revenue / $WOC paid out | At or above 100 percent, structurally | Any payout attempt exceeding budget (should be impossible; alert = bug) |
| Scam/fraud reports | Reports per 1,000 WAU | Falling | Any spike post-graduation-cohort |
| Guild participation | Percent of D30 players in a guild | Above 40 percent | N/A |
| Vote participation | Voters / eligible, per season vote | Above 25 percent | Falling three seasons running |
| Concentration of realm presales | Unique contributors, top-10 share | Top 10 below 40 percent of raise | Above 60 percent |

The trial's published definition of success: **a cohort that retains, spends what it earns, joins guilds, votes, and graduates on-chain at its own pace, inside an economy whose $WOC emissions never exceeded verified revenue.** Price does not appear in that sentence.

## 11. Rollout mapping (what builds where)

| Work item | Basis | New code? |
|---|---|---|
| Claudium faucets/sinks/boutique | Economy service + `claudium_proxy` pattern (PR #6 lineage) | Service config + boutique catalog UI; game-side proxy exists |
| Guild treasuries | `server/social.ts` / `social_db.ts` | Yes: treasury table, contribution log, officer approval flow |
| Daily/weekly quest board | Quest system (`QuestDef`) + economy service grants | Yes: repeatable-quest scheduling (main has no daily faucets today) |
| Learn-and-earn modules | Quest system + i18n catalog | Yes: content + simulated-scam/market quest scripting |
| Vault milestone + gasless claim | Wallet-link v0.11 + fee sponsorship | Yes: sponsorship keeper (small), celebration UI |
| Leaderboard $WOC rewards | Upstream #799 core + #480 semantics | Lands with the gamblefi stack; this trial only sets its knobs |
| Realm-coin launch | Launchpad phases 0-2 (PR #7) + 3-8 per `HANDOFF_REALM_LAUNCHPAD.md` | On the launchpad track, unchanged |
| Society dashboard | `RewardCounters`, flow ledger, service events | Yes: aggregation + admin panel tab |

## 12. Open questions for review

1. Embedded passkey wallet in Phase B, or measure extension-wallet drop-off first? (Doc recommends: measure first, decide at the Phase B gate.)
2. The Claudium power ceiling is set at "rare" quality / sub-dungeon-best budgets. Confirm the exact item-budget line against `docs/design/master-spec.md` bands before pricing the boutique.
3. World-improvement pool share: what percent of market rake? (Straw proposal: 25 percent of the 5 percent market cut, i.e. 1.25 percent of AH volume, revisited quarterly.)
4. Mentor bounty anti-collusion: the design pays on mentee retention milestones; does it also need device/IP heuristics from day one, or post-hoc clawback on flagged pairs?
5. Which jurisdictions are in scope for Phase C/D? (Counsel question; the geo middleware from launchpad phase 8 is the enforcement point either way.)
6. Trial population: open funnel from launch, or a capped first cohort (e.g. 5,000 accounts) for cleaner measurement? (Doc recommends: capped first cohort.)
