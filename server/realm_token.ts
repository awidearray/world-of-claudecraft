// Realm token registry, phase 0 of the realm token launchpad
// (docs/prd/woc/realm-token-launchpad.md). A `realm_tokens` row registers a
// per-realm currency identity on top of the realm registry (#475): symbol, icon,
// launch lifecycle, and a per-realm monetization policy. Phase 0 is registry +
// identity only: NO chain writes, no mint (the Token-2022 mint factory is phase
// 3, so `mint` stays null here), and the founding stake path (realm_tiers.ts,
// realm_stake_escrow, usesToken2022) is untouched: the realm token is a separate
// asset that never backs a tier.
//
// This module is the pure/domain half (types, validation, the currency-display
// resolver, the directory merge, and the register orchestration against the
// RealmTokenDb interface); SQL lives only in realm_token_db.ts, mirroring the
// realm.ts / realm_db.ts split.

import type { DirectoryEntry, RealmRole } from './realm';
import { WOC_DECIMALS, WOC_MINT } from './woc_config';

// Launch lifecycle. Registered tokens are born `prelaunch`; the owner opens the
// community vote (`voting`); a passed vote flips to `presale`; a finalized
// presale lands `funded` (soft cap met) or `refunding` -> `refunded` (missed).
// `live` / `graduated` are reserved for the bonding-curve phases (4+);
// `closed` follows the realm's own teardown.
export type RealmTokenStatus =
  | 'prelaunch'
  | 'voting'
  | 'presale'
  | 'funded'
  | 'refunding'
  | 'refunded'
  | 'live'
  | 'graduated'
  | 'closed';

export const REALM_TOKEN_STATUSES: readonly RealmTokenStatus[] = [
  'prelaunch',
  'voting',
  'presale',
  'funded',
  'refunding',
  'refunded',
  'live',
  'graduated',
  'closed',
];

export function isRealmTokenStatus(raw: string): raw is RealmTokenStatus {
  return (REALM_TOKEN_STATUSES as readonly string[]).includes(raw);
}

// Per-realm monetization policy (PRD D2). `cosmetic` is the default and the
// canonical-realm rule; `power` is a per-clone opt-in. Phase 0 to 2 treat this
// as STORAGE ONLY: no power behavior anywhere reads it yet (the token-to-copper
// credit path is phase 7, behind its own counsel/geo gate).
export type MonetizationPolicy = 'cosmetic' | 'power';

export function isMonetizationPolicy(raw: string): raw is MonetizationPolicy {
  return raw === 'cosmetic' || raw === 'power';
}

export interface RealmToken {
  realmId: number;
  // The Token-2022 mint, once the phase-3 factory creates it. Null through
  // phases 0 to 2 (registry + vote + presale are all pre-mint).
  mint: string | null;
  decimals: number;
  symbol: string;
  icon: string;
  status: RealmTokenStatus;
  monetizationPolicy: MonetizationPolicy;
  curveAddress: string | null;
  poolAddress: string | null;
  lpLockAddress: string | null;
  feeClaimerPda: string | null;
  // UNIQUE replay guard for the phase-3 mint-creation transaction.
  launchTxSig: string | null;
  // Phase 3 launch bookkeeping: the verified distribute-and-renounce
  // transaction (UNIQUE), the fixed supply, the locked buckets' exact base
  // amounts as pinned at distribution, and the verified Jupiter Lock escrow
  // addresses. All null until the corresponding step is verified on-chain.
  distributeTxSig: string | null;
  supplyBase: bigint | null;
  founderAllocBase: bigint | null;
  levyAllocBase: bigint | null;
  treasuryAllocBase: bigint | null;
  founderLockAddress: string | null;
  levyLockAddress: string | null;
  treasuryLockAddress: string | null;
  createdAt: Date;
  updatedAt: Date;
}

// The SQL surface realm_token_db.ts implements and tests fake in memory.
export interface RealmTokenDb {
  getRealmToken(realmId: number): Promise<RealmToken | null>;
  insertRealmToken(t: {
    realmId: number;
    symbol: string;
    icon: string;
    monetizationPolicy: MonetizationPolicy;
  }): Promise<RealmToken>;
  listRealmTokens(realmIds: number[]): Promise<Map<number, RealmToken>>;
  // Guarded CAS: flips status only when the current status is in `from`.
  // Returns the updated row, or null when the token was not in a `from` state.
  setRealmTokenStatus(
    realmId: number,
    from: readonly RealmTokenStatus[],
    to: RealmTokenStatus,
  ): Promise<RealmToken | null>;
  // Phase 3 launch writes, each a guarded CAS on its own null column so a
  // replay or a raced double-submit can never overwrite a verified value.
  // recordMintCreated additionally requires status 'funded' (the only state a
  // mint may be created from). Null = the guard did not match.
  recordMintCreated(realmId: number, mint: string, launchTxSig: string): Promise<RealmToken | null>;
  recordDistribution(
    realmId: number,
    d: {
      distributeTxSig: string;
      supplyBase: bigint;
      founderAllocBase: bigint;
      levyAllocBase: bigint;
      treasuryAllocBase: bigint;
    },
  ): Promise<RealmToken | null>;
  recordLockAddress(
    realmId: number,
    bucket: 'founder' | 'levy' | 'treasury',
    address: string,
  ): Promise<RealmToken | null>;
  // Phase 4: a verified bonding-curve launch records the pool-created mint,
  // the launch signature, the venue addresses, and the pinned bucket amounts
  // in one guarded write (mint IS NULL AND curve IS NULL AND status funded).
  recordCurveLaunch(
    realmId: number,
    d: {
      mint: string;
      launchTxSig: string;
      curveAddress: string;
      poolAddress: string;
      feeClaimerPda: string;
      supplyBase: bigint;
      founderAllocBase: bigint;
      levyAllocBase: bigint;
      treasuryAllocBase: bigint;
    },
  ): Promise<RealmToken | null>;
  // Phase 4: the permanent-LP proof (the graduated DAMM v2 pool), once.
  recordLpLock(realmId: number, address: string): Promise<RealmToken | null>;
  // The public launch-discovery read (PRD section 9's "realm-list integration"):
  // every registered token whose status is one of `statuses`, joined with its
  // realm's display name, for an ACTIVE realm only. Used by the community
  // discovery surface so a non-owner can find a realm mid-vote or mid-presale;
  // the caller passes the exact statuses to include (never hard-coded here).
  listByStatus(statuses: readonly RealmTokenStatus[]): Promise<RealmTokenDiscoveryRow[]>;
}

// A registry row enriched with its realm's display name, for the public
// launch-discovery surface (RealmTokenDb.listByStatus).
export interface RealmTokenDiscoveryRow extends RealmToken {
  realmName: string;
}

// ── Identity validation ───────────────────────────────────────────────────────

// Ticker-style symbol: 2 to 10 upper-alphanumerics starting with a letter.
// 'WOC' itself is reserved (the fallback display currency must stay unambiguous).
const SYMBOL_RE = /^[A-Z][A-Z0-9]{1,9}$/;
export function isRealmTokenSymbol(raw: string): boolean {
  return SYMBOL_RE.test(raw) && raw !== 'WOC';
}

// The icon is a short procedural-icon id (resolved client-side), never a URL or
// raw markup. Empty means "derive from the realm seed" later.
const ICON_RE = /^[a-z0-9_-]{0,32}$/;
export function isRealmTokenIcon(raw: string): boolean {
  return ICON_RE.test(raw);
}

// ── Currency display resolver (pure) ─────────────────────────────────────────

// The display identity of a realm's in-game currency. This is DISPLAY ONLY:
// the sim keeps its opaque numeric balance and the founding stake keeps pricing
// in $WOC; nothing here touches an RPC or a price.
export interface RealmCurrencyConfig {
  symbol: string;
  icon: string;
  mint: string | null;
  decimals: number;
  // False when the realm has no (usable) registered token and displays $WOC.
  realmToken: boolean;
  status: RealmTokenStatus | 'none';
  monetizationPolicy: MonetizationPolicy;
}

export const WOC_CURRENCY: RealmCurrencyConfig = {
  symbol: 'WOC',
  icon: '',
  mint: WOC_MINT || null,
  decimals: WOC_DECIMALS,
  realmToken: false,
  status: 'none',
  monetizationPolicy: 'cosmetic',
};

// Resolve a realm's currency display identity, falling back to the $WOC display
// currency when the realm has no registered token (or its token is closed).
// Pure: the caller supplies the token rows (from RealmTokenDb), so this runs
// identically in tests, the directory merge, and any later IWorld surface.
export function realmTokenConfig(
  realmId: number | null,
  tokens: ReadonlyMap<number, RealmToken>,
): RealmCurrencyConfig {
  if (realmId === null) return WOC_CURRENCY;
  const token = tokens.get(realmId);
  if (!token || token.status === 'closed') return WOC_CURRENCY;
  return {
    symbol: token.symbol,
    icon: token.icon,
    mint: token.mint,
    decimals: token.decimals,
    realmToken: true,
    status: token.status,
    monetizationPolicy: token.monetizationPolicy,
  };
}

// A directory entry enriched with its currency identity (additive: existing
// clients keep reading name/url/type and never see `currency`).
export interface DirectoryEntryWithCurrency extends DirectoryEntry {
  currency: RealmCurrencyConfig;
}

// Attach each merged directory entry's currency identity. Pure companion to
// mergeRealmDirectory (server/realm.ts): env-only realms (realmId null) and
// realms with no registered token display $WOC.
export function mergeDirectoryCurrencies(
  entries: readonly DirectoryEntry[],
  tokens: ReadonlyMap<number, RealmToken>,
): DirectoryEntryWithCurrency[] {
  return entries.map((e) => ({ ...e, currency: realmTokenConfig(e.realmId, tokens) }));
}

// ── Register orchestration ────────────────────────────────────────────────────

export type Result<T> = ({ ok: true } & T) | { ok: false; status: number; error: string };
export function fail(status: number, error: string): { ok: false; status: number; error: string } {
  return { ok: false, status, error };
}

export interface RegisterDeps {
  tokens: RealmTokenDb;
  rolesForAccountOnRealm(realmId: number, accountId: number): Promise<RealmRole[]>;
  realmStatus(realmId: number): Promise<string | null>; // realms.status, null = no realm
  isUniqueViolation(err: unknown): boolean;
}

// Register a realm token identity (phase 0: registry only, no chain writes).
// Owner-only, active realms only, one token per realm. The row is born
// `prelaunch` with the (storage-only) monetization policy defaulting `cosmetic`.
export async function registerRealmToken(
  deps: RegisterDeps,
  args: {
    accountId: number;
    realmId: number;
    symbol: string;
    icon?: string;
    monetizationPolicy?: string;
  },
): Promise<Result<{ token: RealmToken }>> {
  const roles = await deps.rolesForAccountOnRealm(args.realmId, args.accountId);
  if (!roles.includes('owner')) return fail(403, 'not_realm_owner');
  const status = await deps.realmStatus(args.realmId);
  if (status === null) return fail(404, 'realm_not_found');
  if (status !== 'active') return fail(409, 'realm_not_active');

  const symbol = args.symbol.trim().toUpperCase();
  if (!isRealmTokenSymbol(symbol)) return fail(400, 'invalid_token_symbol');
  const icon = (args.icon ?? '').trim();
  if (!isRealmTokenIcon(icon)) return fail(400, 'invalid_token_icon');
  const policy = (args.monetizationPolicy ?? 'cosmetic').trim();
  if (!isMonetizationPolicy(policy)) return fail(400, 'invalid_token_policy');

  if (await deps.tokens.getRealmToken(args.realmId)) return fail(409, 'token_already_registered');
  try {
    const token = await deps.tokens.insertRealmToken({
      realmId: args.realmId,
      symbol,
      icon,
      monetizationPolicy: policy,
    });
    return { ok: true, token };
  } catch (err) {
    if (deps.isUniqueViolation(err)) return fail(409, 'token_already_registered'); // lost the race
    throw err;
  }
}
