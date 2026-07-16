// Power-realm token-to-copper credit (launchpad phase 7, PRD section 6). The
// ONE path where real money buys in-sim power, and it is contained, not
// blanket-enabled:
//
//   - It runs ONLY for a realm whose monetization_policy is `power` (the
//     per-clone opt-in; the canonical realm and every `cosmetic` realm reject
//     it outright).
//   - It is FLAG-GATED and default-off platform-wide (REALM_POWER_CREDIT_ENABLED)
//     until the phase-8 counsel sign-off + geo screening, the same gate the
//     wager features sit behind.
//   - The server credits copper ONLY after verifying a FINALIZED on-chain
//     transfer of the realm's Token-2022 into the realm's power sink, exactly
//     once per signature (UNIQUE(pay_tx_sig) ledger-first).
//   - The sim still only ever sees `copper` credited through its normal
//     server-only grant API (`grantBonus`): no mint, decimals, RPC, or price
//     ever crosses into src/sim/, so determinism and the architecture guard
//     stay intact. The sim has no idea the source was a token.
//
// The conversion is exact bigint: `copper = floor(tokenBase / copperPerCopperUnit)`
// where the rate is configured per platform, never read from the client.
//
// No SQL here (realm_power_credit_db.ts owns it); logic talks to the
// RealmPowerCreditStore interface so tests use an in-memory fake.

import { fail, type RealmTokenDb, type Result } from './realm_token';
import { fetchFinalizedTransaction } from './solana_rpc';
import { parseToken2022Movement } from './solana_token2022';

const BASE58_SIG = /^[1-9A-HJ-NP-Za-km-z]{32,90}$/;

// The platform-wide flag: power-realm credit is DISABLED unless this is set.
// The phase-8 mainnet gate flips it, never a per-request value.
export function powerCreditEnabled(): boolean {
  return (process.env.REALM_POWER_CREDIT_ENABLED ?? '').trim() === '1';
}

// The realm's power sink: the wallet a token transfer must credit for the copper
// grant to count (the founder/realm operations wallet). Configured per realm
// process; without it the credit path is closed.
export function powerSinkWallet(): string | null {
  const raw = (process.env.REALM_POWER_SINK_WALLET ?? '').trim();
  return raw || null;
}

// Token base units per one copper. Default 1e6 (a 9-decimal token: 1000 whole
// tokens buys 1,000,000 copper, i.e. 1 token = 1000 copper). Configured, never
// client-supplied.
export function tokenBasePerCopper(): bigint {
  const raw = (process.env.REALM_POWER_TOKEN_PER_COPPER ?? '').trim();
  if (!/^[0-9]{1,30}$/.test(raw)) return 1_000_000n;
  const v = BigInt(raw);
  return v > 0n ? v : 1_000_000n;
}

// Exact conversion: floor(tokenBase / tokenBasePerCopper). Pure, unit-tested.
export function tokenBaseToCopper(tokenBase: bigint, basePerCopper: bigint): number {
  if (basePerCopper <= 0n) return 0;
  const copper = tokenBase / basePerCopper;
  // The sim's copper is a JS number; clamp to the safe integer range (a single
  // credit past 2^53 copper is absurd and would lose precision).
  return copper > BigInt(Number.MAX_SAFE_INTEGER) ? Number.MAX_SAFE_INTEGER : Number(copper);
}

export interface PowerCreditStore {
  // Ledger-first insert of one verified credit; false when the signature was
  // already recorded (the UNIQUE(pay_tx_sig) replay guard).
  recordCredit(c: {
    realmId: number;
    accountId: number;
    wallet: string;
    tokenBase: bigint;
    copper: number;
    payTxSig: string;
  }): Promise<boolean>;
}

export interface PowerCreditDeps {
  tokens: RealmTokenDb;
  store: PowerCreditStore;
  walletForAccount(accountId: number): Promise<{ pubkey: string } | null>;
  // Apply the copper to the account's active character (live session or
  // persisted state). Returns false when no character can receive it.
  creditCopperToAccount(accountId: number, copper: number): Promise<boolean>;
}

// Verify a finalized Token-2022 transfer of the realm's token into the power
// sink and credit the resulting copper, exactly once. Every gate is checked:
// the platform flag, the realm's `power` policy, the linked wallet as payer,
// the mint, the sink recipient, and the ledger replay guard.
export async function creditTokenToCopper(
  deps: PowerCreditDeps,
  args: { accountId: number; realmId: number; payTxSig: string },
): Promise<Result<{ copper: number }>> {
  if (!powerCreditEnabled()) return fail(403, 'power_credit_disabled');
  if (!BASE58_SIG.test(args.payTxSig)) return fail(400, 'bad_signature');
  const sink = powerSinkWallet();
  if (sink === null) return fail(503, 'power_sink_unconfigured');

  const token = await deps.tokens.getRealmToken(args.realmId);
  if (!token) return fail(404, 'token_not_registered');
  // The monetization_policy gate: cosmetic realms (and the canonical realm)
  // can NEVER convert a token to power.
  if (token.monetizationPolicy !== 'power') return fail(403, 'not_power_realm');
  if (token.mint === null) return fail(409, 'token_not_minted');

  // Identity: the game account's verified linked wallet must be the payer.
  const wallet = await deps.walletForAccount(args.accountId);
  if (!wallet) return fail(400, 'wallet_not_linked');

  const tx = await fetchFinalizedTransaction(args.payTxSig);
  if (!tx) return fail(409, 'not_finalized');
  const movement = parseToken2022Movement(tx, token.mint);
  if (!movement.succeeded) return fail(400, 'tx_failed');
  if (movement.sawForeignProgramForMint) return fail(400, 'token_2022_mismatch');
  if (movement.feePayer !== wallet.pubkey) return fail(400, 'wrong_payer');
  const credited = movement.tokenDeltas.get(sink) ?? 0n;
  if (credited <= 0n) return fail(400, 'sink_not_credited');

  const copper = tokenBaseToCopper(credited, tokenBasePerCopper());
  if (copper <= 0) return fail(400, 'amount_too_small');

  // Ledger-first: record the credit BEFORE granting, so a replay of the same
  // signature is rejected by the UNIQUE guard and can never double-credit.
  const fresh = await deps.store.recordCredit({
    realmId: args.realmId,
    accountId: args.accountId,
    wallet: wallet.pubkey,
    tokenBase: credited,
    copper,
    payTxSig: args.payTxSig,
  });
  if (!fresh) return fail(409, 'credit_already_recorded');

  const applied = await deps.creditCopperToAccount(args.accountId, copper);
  if (!applied) return fail(409, 'no_character_to_credit');
  return { ok: true, copper };
}
