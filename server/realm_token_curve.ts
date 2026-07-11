// Bonding-curve launch orchestration (launchpad phase 4). Sits between the
// phase 0 to 3 registry/lifecycle and the LaunchVenue seam (realm_launchpad.ts):
// the founder launches the realm token ON A CURVE instead of the phase-3
// direct mint, and the same registry columns, allocation pins, lock records,
// and listing gate carry the anti-rug proof.
//
// The curve path in order (all founder-signed, server verify-only):
//   1. CURVE LAUNCH (`prepareCurveQuote` + `confirmCurveLaunch`): one
//      transaction creates the venue config + pool; the POOL creates the base
//      mint (Token-2022, immutable authority). Confirm verifies the LIVE
//      on-chain config against the pinned plan (immutable authority, DAMM v2
//      migration, 100 percent permanently locked LP, founder vesting ==
//      founder bucket, quote mint, PDA fee claimer, founder leftover
//      receiver), then records mint / launch_tx_sig / curve / pool /
//      fee_claimer plus the pinned bucket amounts.
//   2. Trading runs on the curve; graduation to DAMM v2 happens at the
//      on-chain threshold (permissionless cranks the phase-5 keeper sends).
//   3. RECONCILE (`reconcileCurve`, idempotent): once migrated, verifies the
//      founder-vesting locker escrow (the SAME Jupiter Lock accounts phase 3
//      decodes) and the DAMM v2 pool, records founder_lock_address +
//      lp_lock_address, and walks the status through the ONLY door to 'live'
//      (markTokenLive) and on to 'graduated'.
//   4. LEFTOVER (`prepareLeftoverQuote` + `confirmLeftover`): the levy +
//      treasury buckets ride the config leftover to the founder's ATA; the
//      confirm verifies the exact Token-2022 delta and records it as the
//      distribution, after which the UNCHANGED phase-3 lock-quote flow locks
//      the levy and treasury buckets.
//
// No SQL here; no signing beyond what the venue does with its transient
// launch keypairs. The venue is injectable, so tests drive the whole flow
// against the fixed-rate stub and the devnet suite drives the real Meteora
// integration.

import { randomUUID } from 'node:crypto';
import { decodeVestingEscrow, verifyVenueLockerEscrow } from './jup_lock';
import {
  type CurveConfigFacts,
  type CurveLaunchPlan,
  curveFeeClaimer,
  curveLaunchPlan,
  type LaunchVenue,
  verifyCurveConfigFacts,
} from './realm_launchpad';
import { fail, type RealmToken, type Result } from './realm_token';
import { canListRealmToken } from './realm_token_alloc';
import type { LaunchDeps, LaunchQuoteRow } from './realm_token_mint';
import { markTokenLive } from './realm_token_mint';
import { parseToken2022Movement } from './solana_token2022';

const BASE58_SIG = /^[1-9A-HJ-NP-Za-km-z]{32,90}$/;

export interface CurveDeps extends LaunchDeps {
  // Null when curve launches are disabled on this host (no venue configured).
  venue: LaunchVenue | null;
}

function intEnv(key: string, def: number, min: number, max: number): number {
  const v = Number.parseInt(process.env[key] ?? '', 10);
  return Number.isFinite(v) && v >= min && v <= max ? v : def;
}

function quoteTtlMs(): number {
  return intEnv('REALM_LAUNCH_QUOTE_TTL_MINUTES', 15, 1, 1440) * 60_000;
}

async function curveContext(
  deps: CurveDeps,
  args: { accountId: number; realmId: number },
): Promise<Result<{ token: RealmToken; founderWallet: string; venue: LaunchVenue }>> {
  const roles = await deps.rolesForAccountOnRealm(args.realmId, args.accountId);
  if (!roles.includes('owner')) return fail(403, 'not_realm_owner');
  const token = await deps.tokens.getRealmToken(args.realmId);
  if (!token) return fail(404, 'token_not_registered');
  const wallet = await deps.walletForAccount(args.accountId);
  if (!wallet) return fail(400, 'wallet_not_linked');
  if (deps.venue === null) return fail(503, 'curve_disabled');
  return { ok: true, token, founderWallet: wallet.pubkey, venue: deps.venue };
}

// The pinned plan facts a curve quote carries between quote and confirm, all
// strings (JSONB payload discipline: pinned facts only, never key material).
interface CurvePayload {
  configAddress: string;
  poolAddress: string;
  baseMint: string;
  founderWallet: string;
  quote: string;
  quoteMint: string;
  quoteDecimals: string;
  decimals: string;
  supplyBase: string;
  founderAllocBase: string;
  levyAllocBase: string;
  treasuryAllocBase: string;
  feeClaimer: string;
  leftoverReceiver: string;
  vestingCliffFromMigrationSec: string;
  vestingFrequencySec: string;
  vestingNumberOfPeriod: string;
  migrationQuoteThresholdHuman: string;
  feesStartingBps: string;
  feesEndingBps: string;
  feesPeriods: string;
  feesDurationSec: string;
  feesCreatorPct: string;
}

function pinPlan(
  plan: CurveLaunchPlan,
  prepared: { configAddress: string; poolAddress: string; baseMint: string },
  founderWallet: string,
): CurvePayload {
  return {
    configAddress: prepared.configAddress,
    poolAddress: prepared.poolAddress,
    baseMint: prepared.baseMint,
    founderWallet,
    quote: plan.quote,
    quoteMint: plan.quoteMint,
    quoteDecimals: plan.quoteDecimals.toString(),
    decimals: plan.decimals.toString(),
    supplyBase: plan.supplyBase.toString(),
    founderAllocBase: plan.founderAllocBase.toString(),
    levyAllocBase: plan.levyAllocBase.toString(),
    treasuryAllocBase: plan.treasuryAllocBase.toString(),
    feeClaimer: plan.feeClaimer,
    leftoverReceiver: plan.leftoverReceiver,
    vestingCliffFromMigrationSec: plan.vesting.cliffFromMigrationSec.toString(),
    vestingFrequencySec: plan.vesting.frequencySec.toString(),
    vestingNumberOfPeriod: plan.vesting.numberOfPeriod.toString(),
    migrationQuoteThresholdHuman: plan.migrationQuoteThresholdHuman.toString(),
    feesStartingBps: plan.fees.startingFeeBps.toString(),
    feesEndingBps: plan.fees.endingFeeBps.toString(),
    feesPeriods: plan.fees.numberOfPeriod.toString(),
    feesDurationSec: plan.fees.totalDurationSec.toString(),
    feesCreatorPct: plan.fees.creatorTradingFeePercentage.toString(),
  };
}

// Rebuild the exact verification expectations from a pinned payload (never
// from env, which may have changed between quote and confirm).
function planFromPayload(p: CurvePayload): CurveLaunchPlan {
  return {
    quote: p.quote === 'USDC' ? 'USDC' : 'SOL',
    quoteMint: p.quoteMint,
    quoteDecimals: Number(p.quoteDecimals),
    supplyTokens: Number(BigInt(p.supplyBase) / 10n ** BigInt(p.decimals)),
    supplyBase: BigInt(p.supplyBase),
    decimals: Number(p.decimals),
    publicCurveTokens: 0, // unused by verification
    liquidityPercent: 0, // unused by verification
    founderVestingTokens: Number(BigInt(p.founderAllocBase) / 10n ** BigInt(p.decimals)),
    founderAllocBase: BigInt(p.founderAllocBase),
    levyAllocBase: BigInt(p.levyAllocBase),
    treasuryAllocBase: BigInt(p.treasuryAllocBase),
    leftoverTokens: Number(
      (BigInt(p.levyAllocBase) + BigInt(p.treasuryAllocBase)) / 10n ** BigInt(p.decimals),
    ),
    vesting: {
      cliffFromMigrationSec: Number(p.vestingCliffFromMigrationSec),
      frequencySec: Number(p.vestingFrequencySec),
      numberOfPeriod: Number(p.vestingNumberOfPeriod),
    },
    fees: {
      startingFeeBps: Number(p.feesStartingBps),
      endingFeeBps: Number(p.feesEndingBps),
      numberOfPeriod: Number(p.feesPeriods),
      totalDurationSec: Number(p.feesDurationSec),
      creatorTradingFeePercentage: Number(p.feesCreatorPct),
    },
    migrationQuoteThresholdHuman: Number(p.migrationQuoteThresholdHuman),
    feeClaimer: p.feeClaimer,
    leftoverReceiver: p.leftoverReceiver,
  };
}

// ── Step 1: launch the curve ──────────────────────────────────────────────────

export interface CurveQuoteResponse {
  quoteId: string;
  realmId: number;
  txBase64: string;
  configAddress: string;
  poolAddress: string;
  baseMint: string;
  expiresAt: string;
}

export async function prepareCurveQuote(
  deps: CurveDeps,
  args: { accountId: number; realmId: number },
): Promise<Result<{ quote: CurveQuoteResponse }>> {
  const ctx = await curveContext(deps, args);
  if (!ctx.ok) return ctx;
  if (ctx.token.status !== 'funded') return fail(409, 'mint_not_ready');
  if (ctx.token.mint !== null) return fail(409, 'token_already_minted');
  if (ctx.token.curveAddress !== null) return fail(409, 'curve_already_launched');
  if (curveFeeClaimer() === null) return fail(503, 'fee_claimer_unconfigured');
  const plan = curveLaunchPlan(ctx.founderWallet);
  if (plan === null) return fail(503, 'curve_disabled');

  const prepared = await ctx.venue.prepareCurveLaunch({
    plan,
    founderWallet: ctx.founderWallet,
    symbol: ctx.token.symbol,
    name: ctx.token.symbol,
    uri: '',
  });
  if (prepared === null) return fail(503, 'launch_unavailable');

  const quoteId = randomUUID();
  const expiresAt = new Date(Date.now() + quoteTtlMs());
  await deps.quotes.createQuote({
    quoteId,
    realmId: args.realmId,
    accountId: args.accountId,
    kind: 'curve',
    payload: pinPlan(plan, prepared, ctx.founderWallet) as unknown as Record<string, unknown>,
    expiresAt,
  });
  return {
    ok: true,
    quote: {
      quoteId,
      realmId: args.realmId,
      txBase64: prepared.txBase64,
      configAddress: prepared.configAddress,
      poolAddress: prepared.poolAddress,
      baseMint: prepared.baseMint,
      expiresAt: expiresAt.toISOString(),
    },
  };
}

// Verify the finalized launch transaction AND the live on-chain config + pool
// against the pinned plan, then record everything in one guarded write. The
// transaction is bound to the quote by construction: only the quote's own
// partial-signed transaction carries the transient config/baseMint keypair
// signatures, so those exact accounts cannot exist from any other message.
export async function confirmCurveLaunch(
  deps: CurveDeps,
  args: { accountId: number; quoteId: string; signature: string },
): Promise<Result<{ poolAddress: string; baseMint: string }>> {
  const quote = await deps.quotes.getQuote(args.quoteId);
  if (!quote || quote.kind !== 'curve') return fail(404, 'quote_not_found');
  if (quote.accountId !== args.accountId) return fail(403, 'not_your_quote');
  if (quote.expiresAt.getTime() <= Date.now()) return fail(410, 'quote_expired');
  if (!BASE58_SIG.test(args.signature)) return fail(400, 'bad_signature');
  if (deps.venue === null) return fail(503, 'curve_disabled');
  const p = quote.payload as unknown as CurvePayload;

  const tx = await deps.chain.fetchTx(args.signature);
  if (!tx) return fail(409, 'not_finalized');
  const movement = parseToken2022Movement(tx, p.baseMint);
  if (!movement.succeeded) return fail(400, 'tx_failed');
  if (movement.feePayer !== p.founderWallet) return fail(400, 'wrong_payer');

  // The LIVE config account is what the chain will enforce forever; verify it,
  // not the transaction.
  const facts = await deps.venue.configFacts(p.configAddress);
  if (!facts) return fail(409, 'not_finalized');
  const verdict = verifyPayloadAgainstFacts(p, facts);
  if (!verdict.ok) return fail(400, verdict.reason);

  const state = await deps.venue.poolState(p.poolAddress);
  if (!state) return fail(409, 'not_finalized');
  if (
    state.configAddress !== p.configAddress ||
    state.baseMint !== p.baseMint ||
    state.creator !== p.founderWallet
  ) {
    return fail(400, 'curve_mismatch');
  }

  let recorded: RealmToken | null;
  try {
    recorded = await deps.tokens.recordCurveLaunch(quote.realmId, {
      mint: p.baseMint,
      launchTxSig: args.signature,
      curveAddress: p.configAddress,
      poolAddress: p.poolAddress,
      feeClaimerPda: p.feeClaimer,
      supplyBase: BigInt(p.supplyBase),
      founderAllocBase: BigInt(p.founderAllocBase),
      levyAllocBase: BigInt(p.levyAllocBase),
      treasuryAllocBase: BigInt(p.treasuryAllocBase),
    });
  } catch (err) {
    if (deps.isUniqueViolation(err)) return fail(409, 'launch_sig_reused');
    throw err;
  }
  if (!recorded) return fail(409, 'curve_already_launched');
  await deps.quotes.deleteQuote(args.quoteId);
  return { ok: true, poolAddress: p.poolAddress, baseMint: p.baseMint };
}

function verifyPayloadAgainstFacts(
  p: CurvePayload,
  facts: CurveConfigFacts,
): { ok: true } | { ok: false; reason: string } {
  return verifyCurveConfigFacts(facts, planFromPayload(p));
}

// ── Live curve state (panel read + the dry-run assertions) ───────────────────

export interface CurveStateInfo {
  poolAddress: string;
  baseMint: string;
  sqrtPrice: string;
  quoteReserveBase: string;
  migrationQuoteThresholdBase: string;
  progressBps: number;
  isMigrated: boolean;
  isLeftoverWithdrawn: boolean;
  partnerQuoteFeeBase: string;
  dammV2Pool: string | null;
  lockerEscrow: string | null;
}

export async function curveState(
  deps: CurveDeps,
  realmId: number,
): Promise<Result<{ curve: CurveStateInfo }>> {
  const token = await deps.tokens.getRealmToken(realmId);
  if (!token) return fail(404, 'token_not_registered');
  if (token.poolAddress === null) return fail(409, 'curve_not_launched');
  if (deps.venue === null) return fail(503, 'curve_disabled');
  const state = await deps.venue.poolState(token.poolAddress);
  if (!state) return fail(503, 'launch_unavailable');
  const migration = await deps.venue.migrationState(token.poolAddress);
  return {
    ok: true,
    curve: {
      poolAddress: token.poolAddress,
      baseMint: state.baseMint,
      sqrtPrice: state.sqrtPrice.toString(),
      quoteReserveBase: state.quoteReserveBase.toString(),
      migrationQuoteThresholdBase: state.migrationQuoteThresholdBase.toString(),
      progressBps: state.progressBps,
      isMigrated: state.isMigrated,
      isLeftoverWithdrawn: state.isLeftoverWithdrawn,
      partnerQuoteFeeBase: state.partnerQuoteFeeBase.toString(),
      dammV2Pool: migration?.dammV2Pool ?? null,
      lockerEscrow: migration?.lockerEscrow ?? null,
    },
  };
}

// ── Step 3: reconcile the graduation (idempotent) ─────────────────────────────

// Verify what the chain says happened (the founder-vesting locker escrow, the
// DAMM v2 migration) and record it. Records at most once per fact (the
// null-column guards), walks 'funded' -> 'live' through markTokenLive (the
// only door), and 'live' -> 'graduated' once migrated.
export async function reconcileCurve(
  deps: CurveDeps,
  args: { accountId: number; realmId: number },
): Promise<
  Result<{ status: RealmToken['status']; founderLock: string | null; lpLock: string | null }>
> {
  const ctx = await curveContext(deps, args);
  if (!ctx.ok) return ctx;
  const token = ctx.token;
  if (token.poolAddress === null || token.mint === null) return fail(409, 'curve_not_launched');

  const migration = await ctx.venue.migrationState(token.poolAddress);
  if (!migration) return fail(503, 'launch_unavailable');

  const mint = token.mint;
  let current = token;

  // The founder-vesting locker escrow: the same Jupiter Lock account shape
  // phase 3 verifies, created by the venue at migration. Recipient is the pool
  // creator (the founder); the locked total is exactly the founder bucket.
  if (migration.lockerEscrow !== null && current.founderLockAddress === null) {
    const data = await deps.chain.fetchAccountData(migration.lockerEscrow);
    if (data) {
      const escrow = decodeVestingEscrow(data);
      const verdict =
        escrow && current.founderAllocBase !== null
          ? verifyVenueLockerEscrow(escrow, {
              mint,
              recipient: ctx.founderWallet,
              totalBase: current.founderAllocBase,
            })
          : ({ ok: false, reason: 'lock_mismatch' } as const);
      if (!verdict.ok) return fail(400, verdict.reason);
      const recorded = await deps.tokens.recordLockAddress(
        args.realmId,
        'founder',
        migration.lockerEscrow,
      );
      if (recorded) current = recorded;
    }
  }

  // The permanently locked LP: the DAMM v2 pool the curve migrated into. The
  // 100 percent permanent-lock split was verified against the live config at
  // launch confirm; the pool's existence completes the proof.
  if (migration.isMigrated && migration.dammV2Pool !== null && current.lpLockAddress === null) {
    const recorded = await deps.tokens.recordLpLock(args.realmId, migration.dammV2Pool);
    if (recorded) current = recorded;
  }

  if (current.status === 'funded' && canListRealmToken(current)) {
    const live = await markTokenLive(deps, args.realmId);
    if (live.ok) {
      const refreshed = await deps.tokens.getRealmToken(args.realmId);
      if (refreshed) current = refreshed;
    }
  }
  if (current.status === 'live' && migration.isMigrated) {
    const flipped = await deps.tokens.setRealmTokenStatus(args.realmId, ['live'], 'graduated');
    if (flipped) current = flipped;
  }

  return {
    ok: true,
    status: current.status,
    founderLock: current.founderLockAddress,
    lpLock: current.lpLockAddress,
  };
}

// ── Step 4: withdraw the leftover (levy + treasury buckets) ───────────────────

export async function prepareLeftoverQuote(
  deps: CurveDeps,
  args: { accountId: number; realmId: number },
): Promise<
  Result<{ quote: { quoteId: string; realmId: number; txBase64: string; expiresAt: string } }>
> {
  const ctx = await curveContext(deps, args);
  if (!ctx.ok) return ctx;
  const token = ctx.token;
  if (token.poolAddress === null || token.mint === null) return fail(409, 'curve_not_launched');
  if (token.distributeTxSig !== null) return fail(409, 'already_distributed');
  if (
    token.supplyBase === null ||
    token.founderAllocBase === null ||
    token.levyAllocBase === null ||
    token.treasuryAllocBase === null
  ) {
    return fail(409, 'curve_not_launched');
  }
  const state = await ctx.venue.poolState(token.poolAddress);
  if (!state) return fail(503, 'launch_unavailable');
  if (!state.isMigrated) return fail(409, 'not_migrated');

  const txBase64 = await ctx.venue.buildWithdrawLeftoverTx(token.poolAddress, ctx.founderWallet);
  if (txBase64 === null) return fail(503, 'launch_unavailable');

  const quoteId = randomUUID();
  const expiresAt = new Date(Date.now() + quoteTtlMs());
  await deps.quotes.createQuote({
    quoteId,
    realmId: args.realmId,
    accountId: args.accountId,
    kind: 'leftover',
    payload: {
      mint: token.mint,
      founderWallet: ctx.founderWallet,
      supplyBase: token.supplyBase.toString(),
      founderAllocBase: token.founderAllocBase.toString(),
      levyAllocBase: token.levyAllocBase.toString(),
      treasuryAllocBase: token.treasuryAllocBase.toString(),
    },
    expiresAt,
  });
  return {
    ok: true,
    quote: { quoteId, realmId: args.realmId, txBase64, expiresAt: expiresAt.toISOString() },
  };
}

// Verify the finalized leftover withdrawal credited the founder with AT LEAST
// the reserved levy + treasury buckets, then record it as the distribution:
// from here the UNCHANGED phase-3 lock-quote flow locks exactly those pinned
// bucket amounts. The credit can exceed levy + treasury by the unsold public
// curve remainder (a partial-fill curve completion leaves a small base dust in
// the config leftover); that excess is the operator's, outside the lock scheme,
// so a >= check is the correct guarantee (never a strict equality).
export async function confirmLeftover(
  deps: CurveDeps,
  args: { accountId: number; quoteId: string; signature: string },
): Promise<Result<{ distributed: true }>> {
  const quote = await deps.quotes.getQuote(args.quoteId);
  if (!quote || quote.kind !== 'leftover') return fail(404, 'quote_not_found');
  if (quote.accountId !== args.accountId) return fail(403, 'not_your_quote');
  if (quote.expiresAt.getTime() <= Date.now()) return fail(410, 'quote_expired');
  if (!BASE58_SIG.test(args.signature)) return fail(400, 'bad_signature');
  const p = quote.payload as Record<string, string>;

  const tx = await deps.chain.fetchTx(args.signature);
  if (!tx) return fail(409, 'not_finalized');
  const movement = parseToken2022Movement(tx, p.mint);
  if (!movement.succeeded) return fail(400, 'tx_failed');
  if (movement.sawForeignProgramForMint) return fail(400, 'mint_mismatch');
  if (movement.feePayer !== p.founderWallet) return fail(400, 'wrong_payer');
  const reserved = BigInt(p.levyAllocBase) + BigInt(p.treasuryAllocBase);
  const credited = movement.tokenDeltas.get(p.founderWallet) ?? 0n;
  if (credited < reserved) {
    return fail(400, 'distribution_mismatch');
  }

  let recorded: RealmToken | null;
  try {
    recorded = await deps.tokens.recordDistribution(quote.realmId, {
      distributeTxSig: args.signature,
      supplyBase: BigInt(p.supplyBase),
      founderAllocBase: BigInt(p.founderAllocBase),
      levyAllocBase: BigInt(p.levyAllocBase),
      treasuryAllocBase: BigInt(p.treasuryAllocBase),
    });
  } catch (err) {
    if (deps.isUniqueViolation(err)) return fail(409, 'launch_sig_reused');
    throw err;
  }
  if (!recorded) return fail(409, 'already_distributed');
  await deps.quotes.deleteQuote(args.quoteId);
  return { ok: true, distributed: true };
}
