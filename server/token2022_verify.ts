// Scoped Token-2022 verification for the realm token launchpad (phase 3).
//
// The legacy money paths (stake, buy, presale) HARD-REJECT Token-2022 by
// design (a hooked or fee-bearing mint can make "amount sent" != "amount
// received"); that gate is untouched. Realm founder tokens, however, ARE
// Token-2022 by construction, in the boring metadata-only profile (no transfer
// hook, no transfer fee, no freeze, no permanent delegate). This module is the
// verifier scoped to that path ONLY:
//
//  - parseRealmTokenPayment: the Token-2022-aware twin of parseSplitPayment,
//    used exclusively for founder-token transfers (phase 7 power credits).
//  - parseToken2022MintAccount / fetchToken2022MintState: decode a jsonParsed
//    Token-2022 mint (authorities, supply, extensions) so the factory can
//    verify the fair-launch profile on-chain.
//  - decodeVestingEscrow / fetchVestingEscrow: decode a Jupiter Lock
//    VestingEscrow account (layout pinned from jup-ag/jup-lock
//    programs/locker/src/state/vesting_escrow.rs, 288-byte zero-copy struct
//    behind the 8-byte Anchor discriminator) so lock immutability, schedule,
//    and amounts are verified against the chain, never against founder claims.
//  - fetchToken2022OwnedBalance: sum a wallet's balance of one Token-2022 mint
//    (the lock-escrow funding check).
//
// Parsers and decoders are PURE (unit-tested against fixtures); the fetchers
// are thin solanaRpc wrappers like the rest of the server's readers.

import { createHash } from 'node:crypto';
import bs58 from 'bs58';
import { type RawConfirmedTransaction, SPL_TOKEN_2022_PROGRAM, solanaRpc } from './solana_rpc';

// Jupiter Lock (jup-lock), the audited zero-fee vesting locker (PRD section 4.2).
export const JUPITER_LOCK_PROGRAM_ID = (
  process.env.JUPITER_LOCK_PROGRAM_ID ?? 'LocpQgucEQHbqNABEYvBvwoxCPsSbG91A1QaQhQQqjn'
).trim();

// ── Scoped Token-2022 payment parser ─────────────────────────────────────────

export interface ParsedRealmTokenPayment {
  succeeded: boolean;
  feePayer: string | null;
  memo: string | null;
  // owner pubkey -> net base-unit change of the realm token mint (post - pre).
  tokenDeltas: Map<string, bigint>;
}

interface RawTokenBalance {
  owner?: string;
  mint?: string;
  programId?: string;
  uiTokenAmount?: { amount?: string };
}

const MEMO_PROGRAMS = new Set([
  'MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr',
  'Memo1UhkJRfHyvLMcVucJwxXeuD728EqVDDwQDxFMNo',
]);

function pubkeyOf(key: { pubkey: string } | string): string {
  return typeof key === 'string' ? key : key.pubkey;
}

/**
 * Reduce a confirmed jsonParsed transaction to the net ownership deltas of one
 * REALM TOKEN mint under the Token-2022 program. PURE. The inverse gate of
 * parseSplitPayment: balances under the LEGACY token program are ignored (a
 * realm token mint exists under exactly one program, and that program is
 * Token-2022 by the factory's construction), so a legacy look-alike carries no
 * weight here and a Token-2022 row carries none on the legacy paths.
 */
export function parseRealmTokenPayment(
  tx: RawConfirmedTransaction,
  realmTokenMint: string,
): ParsedRealmTokenPayment {
  const message = tx.transaction.message;
  const feePayer = message.accountKeys.length > 0 ? pubkeyOf(message.accountKeys[0]) : null;

  let memo: string | null = null;
  for (const ix of message.instructions) {
    const isMemo =
      ix.program === 'spl-memo' || (ix.programId !== undefined && MEMO_PROGRAMS.has(ix.programId));
    if (isMemo && typeof ix.parsed === 'string') {
      memo = ix.parsed;
      break;
    }
  }

  const pre = new Map<string, bigint>();
  const post = new Map<string, bigint>();
  const accumulate = (into: Map<string, bigint>, rows: RawTokenBalance[] | undefined): void => {
    if (!rows) return;
    for (const row of rows) {
      if (
        row.mint !== realmTokenMint ||
        row.programId !== SPL_TOKEN_2022_PROGRAM ||
        typeof row.owner !== 'string' ||
        typeof row.uiTokenAmount?.amount !== 'string'
      ) {
        continue;
      }
      into.set(row.owner, (into.get(row.owner) ?? 0n) + BigInt(row.uiTokenAmount.amount));
    }
  };
  accumulate(pre, tx.meta?.preTokenBalances);
  accumulate(post, tx.meta?.postTokenBalances);

  const tokenDeltas = new Map<string, bigint>();
  for (const owner of new Set([...pre.keys(), ...post.keys()])) {
    const delta = (post.get(owner) ?? 0n) - (pre.get(owner) ?? 0n);
    if (delta !== 0n) tokenDeltas.set(owner, delta);
  }

  return { succeeded: tx.meta != null && tx.meta.err == null, feePayer, memo, tokenDeltas };
}

// ── Token-2022 mint state (jsonParsed) ───────────────────────────────────────

export interface Token2022MintState {
  ownerProgram: string;
  decimals: number;
  supply: bigint;
  mintAuthority: string | null;
  freezeAuthority: string | null;
  metadataPointer: { authority: string | null; metadataAddress: string | null } | null;
  tokenMetadata: {
    name: string;
    symbol: string;
    uri: string;
    updateAuthority: string | null;
  } | null;
  // Extension names beyond the boring metadata profile (transferFeeConfig,
  // transferHook, permanentDelegate, ...). Must be empty for a clean launch.
  extraExtensions: string[];
}

// The jsonParsed getAccountInfo value shape this reader consumes. Narrow on
// purpose; anything malformed returns null rather than a partial state.
export interface RawParsedAccountValue {
  owner?: string;
  data?: {
    program?: string;
    parsed?: {
      type?: string;
      info?: {
        decimals?: number;
        supply?: string;
        mintAuthority?: string | null;
        freezeAuthority?: string | null;
        extensions?: Array<{ extension?: string; state?: Record<string, unknown> }>;
      };
    };
  };
}

const BORING_EXTENSIONS = new Set(['metadataPointer', 'tokenMetadata']);

/** Decode a jsonParsed account value into a Token2022MintState. PURE. */
export function parseToken2022MintAccount(
  value: RawParsedAccountValue | null,
): Token2022MintState | null {
  if (!value || typeof value.owner !== 'string') return null;
  const parsed = value.data?.parsed;
  const info = parsed?.info;
  if (parsed?.type !== 'mint' || !info) return null;
  if (typeof info.decimals !== 'number' || typeof info.supply !== 'string') return null;
  if (!/^[0-9]+$/.test(info.supply)) return null;

  let metadataPointer: Token2022MintState['metadataPointer'] = null;
  let tokenMetadata: Token2022MintState['tokenMetadata'] = null;
  const extraExtensions: string[] = [];
  for (const ext of info.extensions ?? []) {
    const name = typeof ext.extension === 'string' ? ext.extension : '';
    const state = ext.state ?? {};
    if (name === 'metadataPointer') {
      metadataPointer = {
        authority: typeof state.authority === 'string' ? state.authority : null,
        metadataAddress: typeof state.metadataAddress === 'string' ? state.metadataAddress : null,
      };
    } else if (name === 'tokenMetadata') {
      tokenMetadata = {
        name: typeof state.name === 'string' ? state.name : '',
        symbol: typeof state.symbol === 'string' ? state.symbol : '',
        uri: typeof state.uri === 'string' ? state.uri : '',
        updateAuthority: typeof state.updateAuthority === 'string' ? state.updateAuthority : null,
      };
    } else if (!BORING_EXTENSIONS.has(name)) {
      extraExtensions.push(name || 'unknown');
    }
  }

  return {
    ownerProgram: value.owner,
    decimals: info.decimals,
    supply: BigInt(info.supply),
    mintAuthority: typeof info.mintAuthority === 'string' ? info.mintAuthority : null,
    freezeAuthority: typeof info.freezeAuthority === 'string' ? info.freezeAuthority : null,
    metadataPointer,
    tokenMetadata,
    extraExtensions,
  };
}

export async function fetchToken2022MintState(mint: string): Promise<Token2022MintState | null> {
  const res = await solanaRpc<{ value: RawParsedAccountValue | null }>('getAccountInfo', [
    mint,
    { encoding: 'jsonParsed', commitment: 'finalized' },
  ]);
  return res ? parseToken2022MintAccount(res.value) : null;
}

// ── Jupiter Lock VestingEscrow decode ────────────────────────────────────────

// First 8 bytes of sha256("account:VestingEscrow"): the Anchor account
// discriminator every jup-lock escrow starts with.
export const VESTING_ESCROW_DISCRIMINATOR = createHash('sha256')
  .update('account:VestingEscrow')
  .digest()
  .subarray(0, 8);

// 8-byte discriminator + the 288-byte zero-copy struct.
export const VESTING_ESCROW_ACCOUNT_SIZE = 296;

// jup-lock enums (state/vesting_escrow.rs). Mode 0 means NEITHER creator nor
// recipient may act: cancelMode 0 + updateRecipientMode 0 is the immutable
// profile the launchpad requires.
export const LOCK_MODE_NEITHER = 0;
// token_program_flag: 0 = legacy SPL token, 1 = Token-2022.
export const LOCK_TOKEN_PROGRAM_2022 = 1;

export interface VestingEscrowState {
  recipient: string;
  tokenMint: string;
  creator: string;
  escrowBump: number;
  updateRecipientMode: number;
  cancelMode: number;
  tokenProgramFlag: number;
  cliffTime: bigint;
  frequency: bigint;
  cliffUnlockAmount: bigint;
  amountPerPeriod: bigint;
  numberOfPeriod: bigint;
  totalClaimedAmount: bigint;
  vestingStartTime: bigint;
  cancelledAt: bigint;
}

/**
 * Decode a Jupiter Lock VestingEscrow account's raw data. PURE. Returns null
 * on a wrong discriminator or a truncated buffer (the caller must ALSO check
 * the account is owned by JUPITER_LOCK_PROGRAM_ID; ownership is what makes the
 * bytes trustworthy).
 */
export function decodeVestingEscrow(data: Buffer): VestingEscrowState | null {
  if (data.length < VESTING_ESCROW_ACCOUNT_SIZE) return null;
  if (!data.subarray(0, 8).equals(VESTING_ESCROW_DISCRIMINATOR)) return null;
  return {
    recipient: bs58.encode(data.subarray(8, 40)),
    tokenMint: bs58.encode(data.subarray(40, 72)),
    creator: bs58.encode(data.subarray(72, 104)),
    escrowBump: data.readUInt8(136),
    updateRecipientMode: data.readUInt8(137),
    cancelMode: data.readUInt8(138),
    tokenProgramFlag: data.readUInt8(139),
    cliffTime: data.readBigUInt64LE(144),
    frequency: data.readBigUInt64LE(152),
    cliffUnlockAmount: data.readBigUInt64LE(160),
    amountPerPeriod: data.readBigUInt64LE(168),
    numberOfPeriod: data.readBigUInt64LE(176),
    totalClaimedAmount: data.readBigUInt64LE(184),
    vestingStartTime: data.readBigUInt64LE(192),
    cancelledAt: data.readBigUInt64LE(200),
  };
}

export async function fetchVestingEscrow(address: string): Promise<VestingEscrowState | null> {
  const res = await solanaRpc<{
    value: { owner?: string; data?: [string, string] } | null;
  }>('getAccountInfo', [address, { encoding: 'base64', commitment: 'finalized' }]);
  const value = res?.value;
  if (!value || value.owner !== JUPITER_LOCK_PROGRAM_ID) return null;
  const [payload, encoding] = value.data ?? ['', ''];
  if (encoding !== 'base64' || typeof payload !== 'string') return null;
  return decodeVestingEscrow(Buffer.from(payload, 'base64'));
}

// ── Owned balance of one Token-2022 mint ─────────────────────────────────────

interface RawTokenAccountsByOwner {
  value: Array<{
    account?: {
      data?: {
        parsed?: { info?: { mint?: string; tokenAmount?: { amount?: string } } };
      };
    };
  }>;
}

/**
 * Sum `owner`'s token accounts for `mint` (base units). Used to prove a lock
 * escrow actually HOLDS its bucket (the escrow account is the authority of its
 * vault ATA). Null on RPC failure so callers treat "can't read" as "not
 * verified", never as zero.
 */
export async function fetchToken2022OwnedBalance(
  mint: string,
  owner: string,
): Promise<bigint | null> {
  const res = await solanaRpc<RawTokenAccountsByOwner>('getTokenAccountsByOwner', [
    owner,
    { mint },
    { encoding: 'jsonParsed', commitment: 'finalized' },
  ]);
  if (!res) return null;
  let total = 0n;
  for (const row of res.value) {
    const amount = row.account?.data?.parsed?.info?.tokenAmount?.amount;
    if (typeof amount === 'string' && /^[0-9]+$/.test(amount)) total += BigInt(amount);
  }
  return total;
}
