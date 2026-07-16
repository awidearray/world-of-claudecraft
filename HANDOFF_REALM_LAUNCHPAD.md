# HANDOFF: Realm Token Launchpad, phases 3 to 8

Drop-in task brief for the next teammate or agent. Everything needed is in this
file plus the two documents it points at. Written 2026-07-09.

## Paste-ready prompt

You are continuing the Realm Token Launchpad for World of ClaudeCraft. Phases 0
to 2 are DONE, verified, and pushed; your job is phases 3 to 8, one phase at a
time, each independently green before the next.

READ FIRST, in order:
1. docs/prd/woc/realm-token-launchpad.md (the approved plan; sections 2, 3, 7,
   8, 11 are load-bearing: locked decisions, invariants, economics, Levy Street
   Fund, phase table with acceptance checks).
2. BRANCH_STATE.md at this repo root (what phases 0 to 2 built, file by file,
   with acceptance evidence and the upstream-PR recipe).
3. The repo CLAUDE.md files (root, server/, src/ui/, tests/) for conventions.

WHERE: worktree /Users/futjr/woc/wt-launchpad, branch
feature/woc-realm-token-launchpad-impl (head has phases 0 to 2 + BRANCH_STATE).
Remotes: origin = levy-street/world-of-claudecraft (canonical, NO push access);
fork = awidearray/world-of-claudecraft (push here). Progress PR: fork PR
https://github.com/awidearray/world-of-claudecraft/pull/7 (base launchpad-base,
a frozen marker so the diff shows only launchpad work; push more commits to the
branch and they appear there). Do NOT open an upstream levy-street PR yet: the
realm chain is blocked until the maintainer lands #799 and the #475 re-cut
(exact recipe at the bottom of BRANCH_STATE.md). The release branch moves daily;
if you need to re-freshen, MERGE origin/release/v0.23.0 into the branch (never
rebase), resolve generated i18n by taking a side then `npm run i18n:gen`, union
locale overlays, keep realm-owned files on the branch side, then run the
release-merge-audit skill checklist (.claude/skills/release-merge-audit/).

STATE YOU INHERIT (verified 2026-07-09): merge 2bb4d5084 freshened the base to
release 7a5cec2d3; phases 0/1/2 are commits 047965f1b / e5c481a25 / 1c0c24b5d +
UI 2ae0ef47c; 103 tests across realm_token / realm_vote / realm_presale /
realm_launchpad_view / architecture, tsc clean, grep-proven no server signing in
the presale path. Locked decisions already honored: identity = game account +
verified linked wallet; presale forked from realm_buy (convergence is a
documented follow-up, do not converge mid-feature); monetization_policy stored,
cosmetic default, no power behavior wired.

INVARIANTS, verify on every commit (from PRD sections 2 to 3; non-negotiable):
sim purity (no mint/RPC/price ever enters src/sim; tests/architecture.test.ts
green); server authoritative (accept on-chain claims only after fetching the
finalized tx and verifying exact deltas); non-custodial (server never pools
funds; only the transient mint keypair in phase 3, renounced immediately, and
the existing buyback keeper key); SQL only in *_db.ts with in-memory fakes for
tests; UNIQUE(tx_sig) ledger-first on every money table; NEVER touch
realm_stake_escrow semantics, usesToken2022, the pinned TOKEN_PROGRAM_ID, or
realm_tiers.ts (the new Token-2022 verifier lives ALONGSIDE, scoped to the
founder-token path only); i18n via the flat English-only `launchpad` catalog
domain + M16 non-Latin fills for wordy values; no em/en dashes, no emojis, no AI
attribution, conventional scoped commits; biome --write on changed files only.

YOUR PHASES, in order, each gated on its PRD section-11 acceptance check:
- PHASE 3, Token-2022 mint factory + allocation/locks (server/realm_token_mint.ts,
  realm_token_alloc.ts split math summing to 100 percent, immutable Jupiter
  Locks for founder 12 / levy 8 / treasury 10 buckets, renounce-after-
  distribution, launch_tx_sig UNIQUE, listing blocked until founder + levy + LP
  locks verifiably on-chain, scoped Token-2022 verifier, add @solana/spl-token).
  Devnet dry-run REQUIRED: the devnet deploy conventions and funded keys are
  documented in the repo memory note "WOC devnet deploy" (SOLANA_DEVNET_DEPLOYER;
  the public faucet is dead). Acceptance: devnet mint created + metadata +
  authorities renounced + locks immutable + RugCheck-clean + legacy verifiers
  still reject Token-2022.
- PHASE 4, Meteora DBC bonding curve + DAMM v2 graduation with permanent LP
  lock, behind a thin Launchpad interface (Raydium fallback); feeClaimer is a
  PDA, never an EOA; read fees/thresholds from live on-chain config, never
  hardcode. GATE: its acceptance check is a MAINNET dry-run, which requires the
  owner's explicit sign-off; build + devnet-stub everything, then STOP and ask
  before any mainnet transaction.
- PHASE 5, source-scoped PayoutKeeper claiming DBC fees into the per-realm
  revenue split (operator / global treasury / affiliate / $WOC buy-and-burn)
  with advisory-lock no-double-spend.
- PHASE 6, Levy Street Fund + valuation (levy_fund.ts, token_valuation.ts,
  tiered pricing: DBC sqrtPrice + size-aware swapQuote pre-graduation, Jupiter
  Price v3 batched + Birdeye/DEX Screener cross-check after, Pyth SOL/USD with
  confidence band; rolling median + AUM clamp; EXCLUDE, never zero, illiquid
  holdings) + the display-only daos.fun-style portfolio page. ABSOLUTE LINE: no
  fund-share token, no redemption, no buy/sell controls (securities risk,
  PRD section 8).
- PHASE 7, in-world currency re-skin via a currency-identity field on IWorld
  implemented in BOTH Sim and ClientWorld; hud money display re-skins copper;
  sim still only ever sees opaque copper; power realms credit copper only after
  server-side on-chain verification AND a monetization_policy check.
- PHASE 8, regulatory hardening: OFAC SDN + IP geo middleware on all money
  routes, facilitator ToS, RugCheck/Birdeye clean-score acceptance test,
  pay-to-win labeling. GATE: counsel sign-off recorded before any mainnet
  enablement; all of it flag-gated default-off.

VERIFY WITH: npx tsc --noEmit; npm run i18n:gen then npx vitest run
tests/architecture.test.ts tests/localization_fixes.test.ts
tests/i18n_completeness.test.ts plus every tests/realm_*.test.ts you touch or
add; biome on changed files. Update BRANCH_STATE.md per phase (files,
acceptance results, invariant confirmations, open questions) and push to fork
after each green phase so no work can be stranded.

HUMAN GATES YOU CANNOT CODE AROUND: (1) upstream levy-street PRs wait on the
maintainer landing #799 + the #475 re-cut; (2) phase 4 mainnet dry-run needs
owner sign-off; (3) phase 8 needs counsel + the allocation split re-confirmed
before mainnet; (4) fee-account/treasury key material is ops-owned, never
committed.

## Quick orientation for a human reviewer
- The economics in one line: 60 percent public curve, 10 liquidity (LP
  permanently locked), founder 12 capped 15 (12mo cliff + 36mo linear,
  immutable), Levy fund 8 capped 10 (12+48, strictest, display-only), treasury
  10; a token cannot go live until all locks are verifiably on-chain.
- The regulatory bright lines: non-custodial everywhere; display-only fund (no
  share token, no redemption); counsel + geo gate before mainnet; power realms
  labeled and opt-in per clone, canonical realm always cosmetic.
