// Scoped Token-2022 verifier (launchpad phase 3). The founder token is a
// Token-2022 mint, so its launch transactions CANNOT be verified by the legacy
// parsers (solana_rpc.ts / solana_tx.ts both hard-reject Token-2022, and must
// keep doing so: stake, buy, and presale payments stay legacy-SPL-only). This
// module is the deliberately separate, founder-token-only counterpart: pure
// parsers over the same jsonParsed shapes plus thin raw-RPC readers (no
// @solana/web3.js on the read path, mirroring woc_balance.ts). NOTHING outside
// the launchpad mint/lock flow may import it for payment verification.

import { type RawConfirmedTransaction, solanaRpc } from './solana_rpc';

export const TOKEN_2022_PROGRAM = 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb';

// A confirmed transaction reduced to the founder-token movement: net base-unit
// change per OWNER for one Token-2022 mint. The inverse of parseSplitPayment's
// guard: here a balance row for the mint under the LEGACY program is the
// anomaly (a look-alike mint), flagged and rejected by callers.
export interface ParsedToken2022Movement {
  succeeded: boolean;
  feePayer: string | null;
  memo: string | null;
  // True when any balance row for this mint sits under a program that is NOT
  // Token-2022 (reject: the founder token is Token-2022 by construction).
  sawForeignProgramForMint: boolean;
  tokenDeltas: Map<string, bigint>;
}

const MEMO_PROGRAMS = new Set([
  'MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr',
  'Memo1UhkJRfHyvLMcVucJwxXeuD728EqVDDwQDxFMNo',
]);

function pubkeyOf(key: { pubkey: string } | string): string {
  return typeof key === 'string' ? key : key.pubkey;
}

// PURE. Mirrors parseSplitPayment (solana_rpc.ts) with the program check
// inverted: deltas count only rows held under Token-2022, and any row for the
// mint under another program flags the transaction.
export function parseToken2022Movement(
  tx: RawConfirmedTransaction,
  mint: string,
): ParsedToken2022Movement {
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
  let sawForeignProgramForMint = false;
  const accumulate = (
    into: Map<string, bigint>,
    rows: NonNullable<RawConfirmedTransaction['meta']>['preTokenBalances'],
  ): void => {
    if (!rows) return;
    for (const row of rows) {
      if (row.mint !== mint || typeof row.owner !== 'string') continue;
      if (row.programId !== TOKEN_2022_PROGRAM) {
        sawForeignProgramForMint = true;
        continue;
      }
      if (typeof row.uiTokenAmount?.amount !== 'string') continue;
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

  return {
    succeeded: tx.meta != null && tx.meta.err == null,
    feePayer,
    memo,
    sawForeignProgramForMint,
    tokenDeltas,
  };
}

// ── Parsed mint state ─────────────────────────────────────────────────────────

// The jsonParsed view of a Token-2022 mint account, narrowed to what the
// launch verifier reads: authorities, decimals, supply, and the extension
// list (each extension is a rug vector or a metadata carrier).
export interface ParsedMintExtension {
  extension: string;
  state?: Record<string, unknown>;
}

export interface ParsedMintInfo {
  // 'spl-token-2022' for the founder token; 'spl-token' would mean a legacy
  // look-alike (reject).
  program: string;
  decimals: number;
  supplyBase: bigint;
  mintAuthority: string | null;
  freezeAuthority: string | null;
  extensions: ParsedMintExtension[];
  metadata: { name: string; symbol: string; uri: string; updateAuthority: string | null } | null;
  metadataPointer: { authority: string | null; metadataAddress: string | null } | null;
}

interface RawParsedAccount {
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

// PURE narrowing of a jsonParsed getAccountInfo value for a mint. Returns null
// when the account is not a parsed mint.
export function narrowParsedMint(value: RawParsedAccount | null): ParsedMintInfo | null {
  const parsed = value?.data?.parsed;
  const info = parsed?.info;
  if (!value?.data?.program || parsed?.type !== 'mint' || !info) return null;
  const extensions: ParsedMintExtension[] = [];
  let metadata: ParsedMintInfo['metadata'] = null;
  let metadataPointer: ParsedMintInfo['metadataPointer'] = null;
  for (const e of info.extensions ?? []) {
    if (typeof e?.extension !== 'string') continue;
    extensions.push({ extension: e.extension, state: e.state });
    if (e.extension === 'tokenMetadata' && e.state) {
      metadata = {
        name: typeof e.state.name === 'string' ? e.state.name : '',
        symbol: typeof e.state.symbol === 'string' ? e.state.symbol : '',
        uri: typeof e.state.uri === 'string' ? e.state.uri : '',
        updateAuthority:
          typeof e.state.updateAuthority === 'string' ? e.state.updateAuthority : null,
      };
    }
    if (e.extension === 'metadataPointer' && e.state) {
      metadataPointer = {
        authority: typeof e.state.authority === 'string' ? e.state.authority : null,
        metadataAddress:
          typeof e.state.metadataAddress === 'string' ? e.state.metadataAddress : null,
      };
    }
  }
  return {
    program: value.data.program,
    decimals: typeof info.decimals === 'number' ? info.decimals : -1,
    supplyBase:
      typeof info.supply === 'string' && /^[0-9]+$/.test(info.supply) ? BigInt(info.supply) : -1n,
    mintAuthority: typeof info.mintAuthority === 'string' ? info.mintAuthority : null,
    freezeAuthority: typeof info.freezeAuthority === 'string' ? info.freezeAuthority : null,
    extensions,
    metadata,
    metadataPointer,
  };
}

/** Fetch + narrow a mint account at finalized commitment. Null = not visible. */
export async function fetchParsedMint(mint: string): Promise<ParsedMintInfo | null> {
  const res = await solanaRpc<{ value: RawParsedAccount | null }>('getAccountInfo', [
    mint,
    { encoding: 'jsonParsed', commitment: 'finalized' },
  ]);
  return narrowParsedMint(res?.value ?? null);
}

/** A token account's base-unit balance at finalized commitment. Null = unreadable. */
export async function fetchTokenAccountBalanceBase(tokenAccount: string): Promise<bigint | null> {
  const res = await solanaRpc<{ value: { amount?: string } }>('getTokenAccountBalance', [
    tokenAccount,
    { commitment: 'finalized' },
  ]);
  const amount = res?.value?.amount;
  return typeof amount === 'string' && /^[0-9]+$/.test(amount) ? BigInt(amount) : null;
}

/** Raw account data (base64-decoded) at finalized commitment. Null = missing. */
export async function fetchRawAccountData(address: string): Promise<Uint8Array | null> {
  const res = await solanaRpc<{ value: { data?: [string, string] } | null }>('getAccountInfo', [
    address,
    { encoding: 'base64', commitment: 'finalized' },
  ]);
  const data = res?.value?.data;
  if (!data || data[1] !== 'base64') return null;
  return Uint8Array.from(Buffer.from(data[0], 'base64'));
}

// ── RugCheck-style mint summary ───────────────────────────────────────────────

// The extension whitelist for a "boring" fair-launch mint. Anything else is a
// rug vector the scanners flag (transfer fees make sent != received, hooks and
// delegates can freeze or claw back, close authority can delete the mint).
export const ALLOWED_MINT_EXTENSIONS: readonly string[] = ['metadataPointer', 'tokenMetadata'];

export interface MintRugSummary {
  isToken2022: boolean;
  mintAuthorityNull: boolean;
  freezeAuthorityNull: boolean;
  metadataPresent: boolean;
  metadataImmutable: boolean;
  metadataPointerSelf: boolean;
  forbiddenExtensions: string[];
  clean: boolean;
}

// PURE. The launch acceptance checklist, mirroring what RugCheck / Birdeye
// score: renounced mint authority, no freeze, immutable metadata pointing at
// itself, and no extension outside the boring whitelist.
export function mintRugSummary(mint: string, parsed: ParsedMintInfo): MintRugSummary {
  const forbidden = parsed.extensions
    .map((e) => e.extension)
    .filter((name) => !ALLOWED_MINT_EXTENSIONS.includes(name));
  const summary = {
    isToken2022: parsed.program === 'spl-token-2022',
    mintAuthorityNull: parsed.mintAuthority === null,
    freezeAuthorityNull: parsed.freezeAuthority === null,
    metadataPresent: parsed.metadata !== null && parsed.metadata.symbol.length > 0,
    metadataImmutable: parsed.metadata !== null && parsed.metadata.updateAuthority === null,
    metadataPointerSelf:
      parsed.metadataPointer !== null && parsed.metadataPointer.metadataAddress === mint,
    forbiddenExtensions: forbidden,
  };
  return {
    ...summary,
    clean:
      summary.isToken2022 &&
      summary.mintAuthorityNull &&
      summary.freezeAuthorityNull &&
      summary.metadataPresent &&
      summary.metadataImmutable &&
      summary.metadataPointerSelf &&
      forbidden.length === 0,
  };
}
