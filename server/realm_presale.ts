// Realm token presale (launchpad phase 2): asset-only and NON-CUSTODIAL. Forks
// the realm_buy quote/verify/confirm machinery (server/realm_buy.ts) into a
// single-leg contribution flow: the server pins a quote (currency, exact
// amount, the FOUNDER-OWNED escrow wallet, memo == quoteId, TTL), the
// contributor signs ONE transfer into that escrow, and the server only VERIFIES
// the finalized transaction and records the contribution ledger-first with a
// UNIQUE(tx_sig) replay guard. The server never pools funds, carries no
// settlement credentials, and never signs anything on this path; refunds are
// founder/escrow-signed transactions the server merely verifies.
//
// Rails: SOL (native lamports), USDC, and $WOC (legacy SPL; Token-2022 is
// rejected by the split parser exactly as on the buy path). Stripe fiat is
// DEFERRED (the Aldrin rail exists but is out of scope for phases 0 to 2).
// Caps are per-rail and exact at the boundary (at-cap accepted, one-over
// rejected, rechecked under a row lock at confirm); the soft cap is combined
// across rails by exact bigint fraction math (no pricing, no oracle: the early
// phases stay asset-only by design).
//
// Convergence note: this is the FOURTH commerce core forked from the shared
// quote/verify/confirm shape (marketplace, realm_buy, ads; see PRD section 13
// "Core convergence"). Converging them into one parametric core is a documented
// follow-up, deliberately not done here to keep the fork reviewable.
//
// No SQL here (realm_presale_db.ts owns it); logic talks to the
// RealmPresaleStore interface so tests use an in-memory fake.

import { randomUUID } from 'node:crypto';
import { fail, type RealmToken, type RealmTokenDb, type Result } from './realm_token';
import { fetchFinalizedTransaction, parseNativePayment, parseSplitPayment } from './solana_rpc';
import { isSolanaAddress } from './wallet_link';
import { USDC_MINT, WOC_DECIMALS, WOC_MINT } from './woc_config';

const BASE58_SIG = /^[1-9A-HJ-NP-Za-km-z]{32,90}$/;

export type PresaleCurrency = 'SOL' | 'USDC' | 'WOC';
export const PRESALE_CURRENCIES: readonly PresaleCurrency[] = ['SOL', 'USDC', 'WOC'];

export function isPresaleCurrency(raw: string): raw is PresaleCurrency {
  return raw === 'SOL' || raw === 'USDC' || raw === 'WOC';
}

export interface PresaleCurrencyConfig {
  key: PresaleCurrency;
  mint: string; // '' for native SOL
  decimals: number;
  native: boolean;
}

export function presaleCurrencyConfig(key: PresaleCurrency): PresaleCurrencyConfig {
  switch (key) {
    case 'SOL':
      return { key, mint: '', decimals: 9, native: true };
    case 'USDC':
      return { key, mint: USDC_MINT, decimals: 6, native: false };
    case 'WOC':
      return { key, mint: WOC_MINT, decimals: WOC_DECIMALS, native: false };
  }
}

// One rail's caps, all in that currency's base units. A rail with no caps row is
// disabled (contributions in that currency are rejected).
export interface PresaleRailCaps {
  softCapBase: bigint; // this rail's share of the combined soft-cap target
  raiseCapBase: bigint; // hard total-raise cap for this rail
  walletCapBase: bigint; // per-wallet cap for this rail
}

export interface PresaleConfig {
  realmId: number;
  escrowWallet: string; // founder/escrow-owned; NEVER a server key
  rails: Partial<Record<PresaleCurrency, PresaleRailCaps>>;
  createdAt: Date;
}

export interface PresaleQuoteRow {
  quoteId: string;
  realmId: number;
  accountId: number;
  wallet: string;
  currency: PresaleCurrency;
  amountBase: bigint;
  escrowAddr: string;
  expiresAt: Date;
}

export interface PresaleContribution {
  contributionId: number;
  realmId: number;
  accountId: number;
  wallet: string;
  currency: PresaleCurrency;
  amountBase: bigint;
  payTxSig: string;
  refundTxSig: string | null;
  refundedAt: Date | null;
  createdAt: Date;
}

// The SQL surface realm_presale_db.ts implements and tests fake in memory.
// withPresaleLock serializes confirms per presale (SELECT ... FOR UPDATE in the
// pg implementation), so the cap recheck + ledger insert are exact under
// concurrency; the fake simply runs the callback.
export interface RealmPresaleStore {
  createPresale(config: {
    realmId: number;
    escrowWallet: string;
    rails: Partial<Record<PresaleCurrency, PresaleRailCaps>>;
  }): Promise<void>;
  getPresale(realmId: number): Promise<PresaleConfig | null>;
  createQuote(q: PresaleQuoteRow): Promise<void>;
  getQuote(quoteId: string): Promise<PresaleQuoteRow | null>;
  deleteQuote(quoteId: string): Promise<void>;
  raisedByCurrency(realmId: number): Promise<Map<PresaleCurrency, bigint>>;
  contributedByWallet(realmId: number, wallet: string, currency: PresaleCurrency): Promise<bigint>;
  insertContribution(c: {
    realmId: number;
    accountId: number;
    wallet: string;
    currency: PresaleCurrency;
    amountBase: bigint;
    payTxSig: string;
  }): Promise<void>;
  getContributionByPaySig(payTxSig: string): Promise<PresaleContribution | null>;
  listContributionsForWallet(realmId: number, wallet: string): Promise<PresaleContribution[]>;
  markRefunded(contributionId: number, refundTxSig: string): Promise<boolean>;
  countUnrefunded(realmId: number): Promise<number>;
  withPresaleLock<T>(realmId: number, fn: (locked: RealmPresaleStore) => Promise<T>): Promise<T>;
}

export interface PresaleDeps {
  tokens: RealmTokenDb;
  store: RealmPresaleStore;
  walletForAccount(accountId: number): Promise<{ pubkey: string } | null>;
  rolesForAccountOnRealm(realmId: number, accountId: number): Promise<string[]>;
  isUniqueViolation(err: unknown): boolean;
}

function intEnv(key: string, def: number, min: number, max: number): number {
  const v = Number.parseInt(process.env[key] ?? '', 10);
  return Number.isFinite(v) && v >= min && v <= max ? v : def;
}

// Contribution quotes are short-lived: long enough to sign + finalize, short
// enough that a cap precheck cannot go very stale (the confirm rechecks caps
// exactly under the presale row lock anyway).
function quoteTtlMs(): number {
  return intEnv('REALM_PRESALE_QUOTE_TTL_MINUTES', 10, 1, 1440) * 60_000;
}

// ── Pure cap / progress math ─────────────────────────────────────────────────

export type CapVerdict =
  | { ok: true }
  | { ok: false; reason: 'wallet_cap_exceeded' | 'raise_cap_exceeded' };

// Exact per-rail cap check. At-cap is ACCEPTED (<=); one base unit over is
// rejected. Pure bigint math, unit-tested at the boundaries.
export function checkContributionCaps(args: {
  caps: PresaleRailCaps;
  raisedBase: bigint; // this rail's confirmed total so far
  walletContributedBase: bigint; // this wallet's confirmed total on this rail
  amountBase: bigint;
}): CapVerdict {
  if (args.walletContributedBase + args.amountBase > args.caps.walletCapBase) {
    return { ok: false, reason: 'wallet_cap_exceeded' };
  }
  if (args.raisedBase + args.amountBase > args.caps.raiseCapBase) {
    return { ok: false, reason: 'raise_cap_exceeded' };
  }
  return { ok: true };
}

// Combined soft-cap progress across rails WITHOUT pricing: each rail
// contributes raised/softCap of the target, summed exactly. softCapMet is the
// exact cross-multiplied comparison sum_i(raised_i / soft_i) >= 1; progressBps
// is the floor of that sum in basis points, capped at 10000 for display.
export function presaleProgress(rails: Array<{ raisedBase: bigint; softCapBase: bigint }>): {
  progressBps: number;
  softCapMet: boolean;
} {
  const enabled = rails.filter((r) => r.softCapBase > 0n);
  if (enabled.length === 0) return { progressBps: 0, softCapMet: false };
  // Common denominator: the product of the soft caps.
  let denom = 1n;
  for (const r of enabled) denom *= r.softCapBase;
  let num = 0n;
  for (const r of enabled) num += (r.raisedBase * denom) / r.softCapBase;
  const softCapMet = num >= denom;
  const bps = (num * 10_000n) / denom;
  return { progressBps: Number(bps > 10_000n ? 10_000n : bps), softCapMet };
}

// ── Configure (owner-only, after the vote passes) ────────────────────────────

const MAX_CAP_BASE = 10n ** 30n; // sanity bound well past any real raise

function parseCapTriple(raw: unknown): PresaleRailCaps | null | 'invalid' {
  if (raw == null) return null;
  if (typeof raw !== 'object') return 'invalid';
  const o = raw as Record<string, unknown>;
  const parse = (v: unknown): bigint | null => {
    if (typeof v !== 'string' || !/^[0-9]{1,30}$/.test(v)) return null;
    const n = BigInt(v);
    return n > 0n && n <= MAX_CAP_BASE ? n : null;
  };
  const softCapBase = parse(o.softCapBase);
  const raiseCapBase = parse(o.raiseCapBase);
  const walletCapBase = parse(o.walletCapBase);
  if (softCapBase === null || raiseCapBase === null || walletCapBase === null) return 'invalid';
  if (raiseCapBase < softCapBase) return 'invalid'; // the hard cap can never sit under the target
  if (walletCapBase > raiseCapBase) return 'invalid';
  return { softCapBase, raiseCapBase, walletCapBase };
}

// Create the presale config: the founder-owned escrow wallet plus per-rail caps
// (a rail without caps stays disabled). Only while the token sits in `presale`
// (i.e. after the vote passed) and only once.
export async function configurePresale(
  deps: PresaleDeps,
  args: {
    accountId: number;
    realmId: number;
    escrowWallet: string;
    rails: Record<string, unknown>;
  },
): Promise<Result<{ presale: PresaleConfig }>> {
  const roles = await deps.rolesForAccountOnRealm(args.realmId, args.accountId);
  if (!roles.includes('owner')) return fail(403, 'not_realm_owner');
  const token = await deps.tokens.getRealmToken(args.realmId);
  if (!token) return fail(404, 'token_not_registered');
  if (token.status !== 'presale') return fail(409, 'presale_not_open');
  if (!isSolanaAddress(args.escrowWallet)) return fail(400, 'invalid_escrow_wallet');
  if (await deps.store.getPresale(args.realmId)) return fail(409, 'presale_already_configured');

  const rails: Partial<Record<PresaleCurrency, PresaleRailCaps>> = {};
  for (const key of PRESALE_CURRENCIES) {
    const parsed = parseCapTriple(args.rails[key]);
    if (parsed === 'invalid') return fail(400, 'invalid_presale_caps');
    if (parsed) rails[key] = parsed;
  }
  if (Object.keys(rails).length === 0) return fail(400, 'invalid_presale_caps');

  try {
    await deps.store.createPresale({
      realmId: args.realmId,
      escrowWallet: args.escrowWallet,
      rails,
    });
  } catch (err) {
    if (deps.isUniqueViolation(err)) return fail(409, 'presale_already_configured');
    throw err;
  }
  const presale = await deps.store.getPresale(args.realmId);
  if (!presale) return fail(503, 'presale_unavailable');
  return { ok: true, presale };
}

// ── Info (panel read) ────────────────────────────────────────────────────────

export interface PresaleRailInfo {
  currency: PresaleCurrency;
  mint: string;
  decimals: number;
  native: boolean;
  softCapBase: string;
  raiseCapBase: string;
  walletCapBase: string;
  raisedBase: string;
  myContributedBase: string;
  myRemainingBase: string;
}

export interface PresaleInfo {
  configured: boolean;
  status: RealmToken['status'];
  escrowWallet: string | null;
  progressBps: number;
  softCapMet: boolean;
  rails: PresaleRailInfo[];
  refund: { unrefundedCount: number } | null;
}

export async function presaleInfo(
  deps: PresaleDeps,
  args: { realmId: number; accountId: number | null },
): Promise<Result<{ presale: PresaleInfo }>> {
  const token = await deps.tokens.getRealmToken(args.realmId);
  if (!token) return fail(404, 'token_not_registered');
  const config = await deps.store.getPresale(args.realmId);
  if (!config) {
    return {
      ok: true,
      presale: {
        configured: false,
        status: token.status,
        escrowWallet: null,
        progressBps: 0,
        softCapMet: false,
        rails: [],
        refund: null,
      },
    };
  }
  const raised = await deps.store.raisedByCurrency(args.realmId);
  const wallet = args.accountId === null ? null : await deps.walletForAccount(args.accountId);
  const rails: PresaleRailInfo[] = [];
  const progressInput: Array<{ raisedBase: bigint; softCapBase: bigint }> = [];
  for (const key of PRESALE_CURRENCIES) {
    const caps = config.rails[key];
    if (!caps) continue;
    const cfg = presaleCurrencyConfig(key);
    const raisedBase = raised.get(key) ?? 0n;
    progressInput.push({ raisedBase, softCapBase: caps.softCapBase });
    const mine = wallet
      ? await deps.store.contributedByWallet(args.realmId, wallet.pubkey, key)
      : 0n;
    const remaining = caps.walletCapBase > mine ? caps.walletCapBase - mine : 0n;
    const railRemaining = caps.raiseCapBase > raisedBase ? caps.raiseCapBase - raisedBase : 0n;
    rails.push({
      currency: key,
      mint: cfg.mint,
      decimals: cfg.decimals,
      native: cfg.native,
      softCapBase: caps.softCapBase.toString(),
      raiseCapBase: caps.raiseCapBase.toString(),
      walletCapBase: caps.walletCapBase.toString(),
      raisedBase: raisedBase.toString(),
      myContributedBase: mine.toString(),
      myRemainingBase: (remaining < railRemaining ? remaining : railRemaining).toString(),
    });
  }
  const { progressBps, softCapMet } = presaleProgress(progressInput);
  const refunding = token.status === 'refunding' || token.status === 'refunded';
  return {
    ok: true,
    presale: {
      configured: true,
      status: token.status,
      escrowWallet: config.escrowWallet,
      progressBps,
      softCapMet,
      rails,
      refund: refunding
        ? { unrefundedCount: await deps.store.countUnrefunded(args.realmId) }
        : null,
    },
  };
}

// ── Quote ────────────────────────────────────────────────────────────────────

export interface PresaleQuoteResponse {
  quoteId: string;
  realmId: number;
  currency: PresaleCurrency;
  native: boolean;
  currencyMint: string;
  currencyDecimals: number;
  amountBase: string;
  escrowWallet: string;
  memo: string; // == quoteId
  expiresAt: string;
}

// Pin a contribution quote: identity (linked wallet), an open configured
// presale, an enabled rail, and a cap precheck (rechecked exactly at confirm).
export async function preparePresaleQuote(
  deps: PresaleDeps,
  args: { accountId: number; realmId: number; currency: string; amountBase: string },
): Promise<Result<{ quote: PresaleQuoteResponse }>> {
  if (!isPresaleCurrency(args.currency)) return fail(400, 'invalid_currency');
  if (!/^[0-9]{1,30}$/.test(args.amountBase)) return fail(400, 'invalid_amount');
  const amountBase = BigInt(args.amountBase);
  if (amountBase <= 0n) return fail(400, 'invalid_amount');

  const token = await deps.tokens.getRealmToken(args.realmId);
  if (!token) return fail(404, 'token_not_registered');
  if (token.status !== 'presale') return fail(409, 'presale_not_open');
  const config = await deps.store.getPresale(args.realmId);
  if (!config) return fail(409, 'presale_not_configured');
  const caps = config.rails[args.currency];
  if (!caps) return fail(400, 'currency_not_enabled');

  // Presale identity: game account + verified linked wallet (the #473 rail).
  const wallet = await deps.walletForAccount(args.accountId);
  if (!wallet) return fail(400, 'wallet_not_linked');

  const raised = (await deps.store.raisedByCurrency(args.realmId)).get(args.currency) ?? 0n;
  const mine = await deps.store.contributedByWallet(args.realmId, wallet.pubkey, args.currency);
  const verdict = checkContributionCaps({
    caps,
    raisedBase: raised,
    walletContributedBase: mine,
    amountBase,
  });
  if (!verdict.ok) return fail(409, verdict.reason);

  const cfg = presaleCurrencyConfig(args.currency);
  const quoteId = randomUUID();
  const expiresAt = new Date(Date.now() + quoteTtlMs());
  await deps.store.createQuote({
    quoteId,
    realmId: args.realmId,
    accountId: args.accountId,
    wallet: wallet.pubkey,
    currency: args.currency,
    amountBase,
    escrowAddr: config.escrowWallet,
    expiresAt,
  });
  return {
    ok: true,
    quote: {
      quoteId,
      realmId: args.realmId,
      currency: args.currency,
      native: cfg.native,
      currencyMint: cfg.mint,
      currencyDecimals: cfg.decimals,
      amountBase: amountBase.toString(),
      escrowWallet: config.escrowWallet,
      memo: quoteId,
      expiresAt: expiresAt.toISOString(),
    },
  };
}

// ── Verify (pure against chain; no DB writes, no signing) ────────────────────

export type PresaleVerdict = { ok: true } | { ok: false; reason: string };
const bad = (reason: string): PresaleVerdict => ({ ok: false, reason });

// Verify that `paySig` is a finalized transfer by `wallet` crediting at least
// `amountBase` of `currency` to `escrow`, tagged with `memo`. Mirrors
// verifyBuyPayment (single leg): SOL via native lamport deltas, USDC/$WOC via
// the SPL token-delta parser with Token-2022 rejected outright.
export async function verifyPresaleContribution(args: {
  paySig: string;
  wallet: string;
  currency: PresaleCurrency;
  escrow: string;
  amountBase: bigint;
  memo: string;
}): Promise<PresaleVerdict> {
  if (!BASE58_SIG.test(args.paySig)) return bad('bad_signature');
  const tx = await fetchFinalizedTransaction(args.paySig);
  if (!tx) return bad('not_finalized');

  const cfg = presaleCurrencyConfig(args.currency);
  if (cfg.native) {
    const p = parseNativePayment(tx);
    if (!p.succeeded) return bad('tx_failed');
    if (p.memo !== args.memo) return bad('memo_mismatch');
    if (p.feePayer !== args.wallet) return bad('wrong_payer');
    if ((p.lamportDeltas.get(args.escrow) ?? 0n) < args.amountBase) return bad('escrow_short');
    return { ok: true };
  }
  const p = parseSplitPayment(tx, cfg.mint);
  if (!p.succeeded) return bad('tx_failed');
  if (p.usesToken2022ForMint) return bad('token_2022');
  if (p.memo !== args.memo) return bad('memo_mismatch');
  if (p.feePayer !== args.wallet) return bad('wrong_payer');
  if ((p.tokenDeltas.get(args.escrow) ?? 0n) < args.amountBase) return bad('escrow_short');
  return { ok: true };
}

// Verify a founder/escrow-signed REFUND: a finalized transfer signed (fee-paid)
// by the escrow wallet, crediting at least the contribution's amount back to
// the contributor, tagged with the ORIGINAL contribution signature as its memo
// so one refund transaction binds to exactly one contribution. The server only
// verifies; it never signs or pays refunds.
export async function verifyPresaleRefund(args: {
  refundSig: string;
  escrowWallet: string;
  contributorWallet: string;
  currency: PresaleCurrency;
  amountBase: bigint;
  memo: string; // == the contribution's pay_tx_sig
}): Promise<PresaleVerdict> {
  if (!BASE58_SIG.test(args.refundSig)) return bad('bad_signature');
  const tx = await fetchFinalizedTransaction(args.refundSig);
  if (!tx) return bad('not_finalized');

  const cfg = presaleCurrencyConfig(args.currency);
  if (cfg.native) {
    const p = parseNativePayment(tx);
    if (!p.succeeded) return bad('tx_failed');
    if (p.memo !== args.memo) return bad('memo_mismatch');
    if (p.feePayer !== args.escrowWallet) return bad('wrong_refunder');
    if ((p.lamportDeltas.get(args.contributorWallet) ?? 0n) < args.amountBase)
      return bad('refund_short');
    return { ok: true };
  }
  const p = parseSplitPayment(tx, cfg.mint);
  if (!p.succeeded) return bad('tx_failed');
  if (p.usesToken2022ForMint) return bad('token_2022');
  if (p.memo !== args.memo) return bad('memo_mismatch');
  if (p.feePayer !== args.escrowWallet) return bad('wrong_refunder');
  if ((p.tokenDeltas.get(args.contributorWallet) ?? 0n) < args.amountBase)
    return bad('refund_short');
  return { ok: true };
}

// ── Confirm ──────────────────────────────────────────────────────────────────

// Redeem a contribution quote with the finalized signature: verify on chain,
// then, under the presale row lock, recheck BOTH caps exactly against the
// confirmed ledger and insert the contribution ledger-first (UNIQUE(pay_tx_sig)
// rejects a replay). Nothing is granted in phases 0 to 2, so ledger-first is
// the entire write.
export async function confirmPresaleContribution(
  deps: PresaleDeps,
  args: { accountId: number; quoteId: string; paySig: string },
): Promise<Result<{ contributionRecorded: true }>> {
  const quote = await deps.store.getQuote(args.quoteId);
  if (!quote) return fail(404, 'quote_not_found');
  if (quote.accountId !== args.accountId) return fail(403, 'not_your_quote');
  if (quote.expiresAt.getTime() <= Date.now()) return fail(410, 'quote_expired');

  const token = await deps.tokens.getRealmToken(quote.realmId);
  if (!token || token.status !== 'presale') return fail(409, 'presale_not_open');
  const config = await deps.store.getPresale(quote.realmId);
  const caps = config?.rails[quote.currency];
  if (!config || !caps) return fail(409, 'presale_not_configured');

  const verdict = await verifyPresaleContribution({
    paySig: args.paySig,
    wallet: quote.wallet,
    currency: quote.currency,
    escrow: quote.escrowAddr,
    amountBase: quote.amountBase,
    memo: quote.quoteId,
  });
  if (!verdict.ok) return fail(400, verdict.reason);

  try {
    await deps.store.withPresaleLock(quote.realmId, async (locked) => {
      const raised = (await locked.raisedByCurrency(quote.realmId)).get(quote.currency) ?? 0n;
      const mine = await locked.contributedByWallet(quote.realmId, quote.wallet, quote.currency);
      const capVerdict = checkContributionCaps({
        caps,
        raisedBase: raised,
        walletContributedBase: mine,
        amountBase: quote.amountBase,
      });
      if (!capVerdict.ok) throw new CapError(capVerdict.reason);
      await locked.insertContribution({
        realmId: quote.realmId,
        accountId: quote.accountId,
        wallet: quote.wallet,
        currency: quote.currency,
        amountBase: quote.amountBase,
        payTxSig: args.paySig,
      });
    });
  } catch (err) {
    if (err instanceof CapError) return fail(409, err.reason);
    if (deps.isUniqueViolation(err)) {
      await deps.store.deleteQuote(args.quoteId);
      return fail(409, 'contribution_already_recorded');
    }
    throw err;
  }
  await deps.store.deleteQuote(args.quoteId);
  return { ok: true, contributionRecorded: true };
}

class CapError extends Error {
  constructor(readonly reason: 'wallet_cap_exceeded' | 'raise_cap_exceeded') {
    super(reason);
  }
}

// ── Finalize + refund path ───────────────────────────────────────────────────

// Owner ends the presale: soft cap met -> `funded`; missed -> `refunding` (the
// founder then issues escrow-signed refunds the server verifies below). Both
// flips are guarded CAS from `presale`.
export async function finalizePresale(
  deps: PresaleDeps,
  args: { accountId: number; realmId: number },
): Promise<Result<{ status: RealmToken['status'] }>> {
  const roles = await deps.rolesForAccountOnRealm(args.realmId, args.accountId);
  if (!roles.includes('owner')) return fail(403, 'not_realm_owner');
  const token = await deps.tokens.getRealmToken(args.realmId);
  if (!token) return fail(404, 'token_not_registered');
  if (token.status !== 'presale') return fail(409, 'presale_not_open');
  const config = await deps.store.getPresale(args.realmId);
  if (!config) return fail(409, 'presale_not_configured');

  const raised = await deps.store.raisedByCurrency(args.realmId);
  const rails: Array<{ raisedBase: bigint; softCapBase: bigint }> = [];
  for (const key of PRESALE_CURRENCIES) {
    const caps = config.rails[key];
    if (caps) rails.push({ raisedBase: raised.get(key) ?? 0n, softCapBase: caps.softCapBase });
  }
  const { softCapMet } = presaleProgress(rails);
  const to = softCapMet ? 'funded' : 'refunding';
  const flipped = await deps.tokens.setRealmTokenStatus(args.realmId, ['presale'], to);
  if (!flipped) return fail(409, 'presale_not_open'); // lost a concurrent finalize
  return { ok: true, status: flipped.status };
}

// Record a verified, founder/escrow-signed refund against one contribution.
// The server VERIFIES the finalized refund transaction (escrow fee payer,
// contributor credited, memo == the contribution's pay signature) and marks
// the ledger row; when every contribution is refunded the token flips
// refunding -> refunded. The server never pays: a missing refund stays visibly
// unrefunded on the panel.
export async function confirmPresaleRefund(
  deps: PresaleDeps,
  args: { realmId: number; payTxSig: string; refundSig: string },
): Promise<Result<{ refunded: true; unrefundedCount: number }>> {
  const token = await deps.tokens.getRealmToken(args.realmId);
  if (!token) return fail(404, 'token_not_registered');
  if (token.status !== 'refunding' && token.status !== 'refunded') {
    return fail(409, 'presale_not_refunding');
  }
  const config = await deps.store.getPresale(args.realmId);
  if (!config) return fail(409, 'presale_not_configured');

  const contribution = await deps.store.getContributionByPaySig(args.payTxSig);
  if (!contribution || contribution.realmId !== args.realmId) {
    return fail(404, 'contribution_not_found');
  }
  if (contribution.refundTxSig !== null) return fail(409, 'already_refunded');

  const verdict = await verifyPresaleRefund({
    refundSig: args.refundSig,
    escrowWallet: config.escrowWallet,
    contributorWallet: contribution.wallet,
    currency: contribution.currency,
    amountBase: contribution.amountBase,
    memo: contribution.payTxSig,
  });
  if (!verdict.ok) return fail(400, verdict.reason);

  let marked: boolean;
  try {
    marked = await deps.store.markRefunded(contribution.contributionId, args.refundSig);
  } catch (err) {
    // UNIQUE(refund_tx_sig): this refund transaction already covered another row.
    if (deps.isUniqueViolation(err)) return fail(409, 'refund_sig_reused');
    throw err;
  }
  if (!marked) return fail(409, 'already_refunded');

  const unrefundedCount = await deps.store.countUnrefunded(args.realmId);
  if (unrefundedCount === 0) {
    await deps.tokens.setRealmTokenStatus(args.realmId, ['refunding'], 'refunded');
  }
  return { ok: true, refunded: true, unrefundedCount };
}
