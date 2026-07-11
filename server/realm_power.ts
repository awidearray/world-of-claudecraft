// Power-realm token-to-copper credits (launchpad phase 7, PRD section 6).
//
// A `power` realm (founder opt-in, plainly labeled) may let players convert
// its realm token into in-game copper. The BRIGHT LINES, all enforced here:
//
//  - The sim stays pure: copper is credited through the same grantBonus API
//    every other server-side grant uses. No mint, decimals, RPC, or price
//    ever crosses into src/sim/.
//  - monetization_policy is CHECKED ON EVERY QUOTE AND CONFIRM: a `cosmetic`
//    realm (the default, and always the canonical realm) can never convert.
//  - Server authoritative + non-custodial: the player transfers realm tokens
//    to the realm treasury sink; the server VERIFIES the finalized transfer
//    with the SCOPED Token-2022 verifier (token2022_verify.ts) and credits
//    copper ledger-first (UNIQUE pay_tx_sig). The server signs nothing.
//  - Flag-gated DEFAULT OFF platform-wide (REALM_POWER_CREDIT_ENABLED): power
//    conversion sits in the same high-reg-risk band as the wager features and
//    stays dark until the phase 8 counsel + geo gate clears it.
//
// No SQL here (realm_power_db.ts owns the quote + credit ledger).

import { randomUUID } from 'node:crypto';
import { fail, type RealmTokenDb, type Result } from './realm_token';
import type { RealmTokenLaunchStore } from './realm_token_mint';
import type { RawConfirmedTransaction } from './solana_rpc';
import { parseRealmTokenPayment } from './token2022_verify';

const BASE58_SIG = /^[1-9A-HJ-NP-Za-km-z]{32,90}$/;
const TOKEN_BASE = 10n ** 9n; // realm tokens are fixed at 9 decimals (phase 3)

// ── Config gates ─────────────────────────────────────────────────────────────

export function powerCreditEnabled(env: Record<string, string | undefined> = process.env): boolean {
  return (env.REALM_POWER_CREDIT_ENABLED ?? '').trim() === '1';
}

// Copper credited per WHOLE realm token. 0 (the default) keeps conversion off
// even when the flag is up: both knobs must be deliberately set.
export function copperPerWholeToken(env: Record<string, string | undefined> = process.env): bigint {
  const raw = env.REALM_POWER_COPPER_PER_TOKEN;
  if (raw === undefined || !/^[0-9]{1,12}$/.test(raw.trim())) return 0n;
  return BigInt(raw.trim());
}

// Exact conversion: floor(amountBase * rate / 10^9). Pure.
export function copperCreditFor(amountBase: bigint, ratePerWholeToken: bigint): bigint {
  if (amountBase <= 0n || ratePerWholeToken <= 0n) return 0n;
  return (amountBase * ratePerWholeToken) / TOKEN_BASE;
}

// ── Persistence surface (SQL in realm_power_db.ts) ───────────────────────────

export interface PowerQuoteRow {
  quoteId: string;
  realmId: number;
  accountId: number;
  characterId: number;
  wallet: string;
  amountBase: bigint;
  copperCredit: bigint;
  sinkWallet: string;
  expiresAt: Date;
}

export interface RealmPowerStore {
  createQuote(q: PowerQuoteRow): Promise<void>;
  getQuote(quoteId: string): Promise<PowerQuoteRow | null>;
  deleteQuote(quoteId: string): Promise<void>;
  // Ledger-first credit insert; UNIQUE(pay_tx_sig) rejects a replay. The row
  // is born uncredited; the game grants it to the character (live now, or on
  // their next join) and marks it credited exactly once.
  insertCredit(c: {
    realmId: number;
    accountId: number;
    characterId: number;
    wallet: string;
    amountBase: bigint;
    copperCredit: bigint;
    payTxSig: string;
  }): Promise<void>;
}

export interface PowerDeps {
  tokens: RealmTokenDb;
  launches: RealmTokenLaunchStore;
  store: RealmPowerStore;
  walletForAccount(accountId: number): Promise<{ pubkey: string } | null>;
  // The account owns this character (server-side ownership check).
  ownsCharacter(accountId: number, characterId: number): Promise<boolean>;
  fetchTx(sig: string): Promise<RawConfirmedTransaction | null>;
  isUniqueViolation(err: unknown): boolean;
  env?: Record<string, string | undefined>;
}

function quoteTtlMs(env: Record<string, string | undefined>): number {
  const v = Number.parseInt(env.REALM_POWER_QUOTE_TTL_MINUTES ?? '', 10);
  return (Number.isFinite(v) && v >= 1 && v <= 1440 ? v : 10) * 60_000;
}

// The shared gate every power operation runs: flag up, token registered with
// the `power` policy, trading live, mint created, a rate configured, and a
// treasury sink to receive the tokens.
async function powerGate(
  deps: PowerDeps,
  realmId: number,
): Promise<
  | { ok: true; mint: string; sinkWallet: string; rate: bigint }
  | { ok: false; status: number; error: string }
> {
  const env = deps.env ?? process.env;
  if (!powerCreditEnabled(env)) return fail(503, 'power_disabled');
  const token = await deps.tokens.getRealmToken(realmId);
  if (!token) return fail(404, 'token_not_registered');
  // THE policy check (PRD D2): cosmetic realms never convert money to power.
  if (token.monetizationPolicy !== 'power') return fail(403, 'realm_not_power');
  if (token.status !== 'live' && token.status !== 'graduated') return fail(409, 'token_not_live');
  if (token.mint === null) return fail(409, 'mint_not_created');
  const rate = copperPerWholeToken(env);
  if (rate <= 0n) return fail(503, 'power_rate_unset');
  const launch = await deps.launches.getLaunch(realmId);
  if (!launch) return fail(503, 'power_sink_unavailable');
  return { ok: true, mint: token.mint, sinkWallet: launch.treasuryWallet, rate };
}

// ── Quote ────────────────────────────────────────────────────────────────────

export interface PowerQuoteResponse {
  quoteId: string;
  realmId: number;
  mint: string;
  amountBase: string;
  copperCredit: string;
  sinkWallet: string;
  memo: string; // == quoteId
  expiresAt: string;
}

export async function preparePowerQuote(
  deps: PowerDeps,
  args: { accountId: number; realmId: number; characterId: number; amountBase: string },
): Promise<Result<{ quote: PowerQuoteResponse }>> {
  const gate = await powerGate(deps, args.realmId);
  if (!gate.ok) return gate;
  if (!/^[0-9]{1,30}$/.test(args.amountBase)) return fail(400, 'invalid_amount');
  const amountBase = BigInt(args.amountBase);
  const copperCredit = copperCreditFor(amountBase, gate.rate);
  if (copperCredit <= 0n) return fail(400, 'amount_below_minimum');

  const wallet = await deps.walletForAccount(args.accountId);
  if (!wallet) return fail(400, 'wallet_not_linked');
  if (!(await deps.ownsCharacter(args.accountId, args.characterId))) {
    return fail(404, 'character_not_found');
  }

  const env = deps.env ?? process.env;
  const quoteId = randomUUID();
  const expiresAt = new Date(Date.now() + quoteTtlMs(env));
  await deps.store.createQuote({
    quoteId,
    realmId: args.realmId,
    accountId: args.accountId,
    characterId: args.characterId,
    wallet: wallet.pubkey,
    amountBase,
    copperCredit,
    sinkWallet: gate.sinkWallet,
    expiresAt,
  });
  return {
    ok: true,
    quote: {
      quoteId,
      realmId: args.realmId,
      mint: gate.mint,
      amountBase: amountBase.toString(),
      copperCredit: copperCredit.toString(),
      sinkWallet: gate.sinkWallet,
      memo: quoteId,
      expiresAt: expiresAt.toISOString(),
    },
  };
}

// ── Confirm ──────────────────────────────────────────────────────────────────

// Redeem a quote with the finalized transfer signature: the SCOPED Token-2022
// verifier checks the exact realm-token delta into the treasury sink, bound to
// the quote by memo and payer, then the credit is written LEDGER-FIRST. The
// copper grant itself runs through the game (live session now, or the
// character's next join): the caller receives the characterId to poke.
export async function confirmPowerCredit(
  deps: PowerDeps,
  args: { accountId: number; quoteId: string; paySig: string },
): Promise<Result<{ characterId: number; copperCredit: string }>> {
  const quote = await deps.store.getQuote(args.quoteId);
  if (!quote) return fail(404, 'quote_not_found');
  if (quote.accountId !== args.accountId) return fail(403, 'not_your_quote');
  if (quote.expiresAt.getTime() <= Date.now()) return fail(410, 'quote_expired');
  const gate = await powerGate(deps, quote.realmId);
  if (!gate.ok) return gate;
  if (!BASE58_SIG.test(args.paySig)) return fail(400, 'bad_signature');

  const tx = await deps.fetchTx(args.paySig);
  if (!tx) return fail(400, 'not_finalized');
  const payment = parseRealmTokenPayment(tx, gate.mint);
  if (!payment.succeeded) return fail(400, 'tx_failed');
  if (payment.memo !== quote.quoteId) return fail(400, 'memo_mismatch');
  if (payment.feePayer !== quote.wallet) return fail(400, 'wrong_payer');
  if ((payment.tokenDeltas.get(quote.sinkWallet) ?? 0n) < quote.amountBase) {
    return fail(400, 'sink_short');
  }

  try {
    await deps.store.insertCredit({
      realmId: quote.realmId,
      accountId: quote.accountId,
      characterId: quote.characterId,
      wallet: quote.wallet,
      amountBase: quote.amountBase,
      copperCredit: quote.copperCredit,
      payTxSig: args.paySig,
    });
  } catch (err) {
    if (deps.isUniqueViolation(err)) {
      await deps.store.deleteQuote(args.quoteId);
      return fail(409, 'credit_already_recorded');
    }
    throw err;
  }
  await deps.store.deleteQuote(args.quoteId);
  return { ok: true, characterId: quote.characterId, copperCredit: quote.copperCredit.toString() };
}
