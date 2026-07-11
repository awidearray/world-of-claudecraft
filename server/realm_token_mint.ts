// Token-2022 mint factory + allocation/locks (launchpad phase 3, PRD sections
// 5.2 and 5.9). The founder token is minted NON-CUSTODIALLY in three
// founder-signed steps, each pinned by a server quote and verified against the
// finalized chain before anything is recorded:
//
//   1. CREATE: the server builds one create-mint transaction (boring
//      metadata-only Token-2022: 9 decimals, freeze authority never set,
//      immutable metadata pointer to itself), partial-signs with a TRANSIENT
//      mint keypair (generated, signs, discarded: it is never persisted and
//      never returned), and the founder co-signs and pays rent. The mint
//      authority is the FOUNDER, never the server.
//   2. DISTRIBUTE + RENOUNCE: one atomic transaction mints the fixed supply
//      per the allocation table (public curve + liquidity to the presale
//      escrow wallet for the phase-4 curve seed; founder + levy + treasury to
//      the founder's own ATA for immediate locking) and, in the SAME
//      transaction, renounces the mint authority and the metadata update
//      authority. After this lands nobody can ever mint or edit again.
//   3. LOCK x3: each locked bucket goes into an immutable Jupiter Lock
//      vesting escrow (founder 12mo cliff + 36mo linear, levy 12 + 48 the
//      strictest, treasury 12 + 36) that nobody can cancel or redirect.
//
// The server holds NO settlement credentials on this path (the transient
// keypairs cannot move funds: the mint keypair only authorizes the account
// creation and the lock base keypair only namespaces the escrow PDA). A token
// may not list (status may not reach 'live') until the founder, levy, and LP
// locks are all verifiably on-chain: markTokenLive is the ONLY door to 'live'.
//
// Verification of everything Token-2022 goes through the SCOPED verifier
// (solana_token2022.ts); the legacy stake/buy/presale parsers keep rejecting
// Token-2022 untouched. No SQL here (realm_token_db.ts / realm_token_mint_db.ts
// own it); logic talks to interfaces so tests use in-memory fakes.

import { randomUUID } from 'node:crypto';
import {
  AuthorityType,
  createAssociatedTokenAccountIdempotentInstruction,
  createInitializeMetadataPointerInstruction,
  createInitializeMintInstruction,
  createMintToCheckedInstruction,
  createSetAuthorityInstruction,
  ExtensionType,
  getAssociatedTokenAddressSync,
  getMintLen,
  LENGTH_SIZE,
  TOKEN_2022_PROGRAM_ID,
  TYPE_SIZE,
} from '@solana/spl-token';
import {
  createInitializeInstruction,
  createUpdateAuthorityInstruction,
  pack,
  type TokenMetadata,
} from '@solana/spl-token-metadata';
import {
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
  TransactionInstruction,
} from '@solana/web3.js';
import {
  buildCreateVestingEscrowV2Ix,
  decodeVestingEscrow,
  deriveEscrowPda,
  escrowTokenAta,
  verifyLockedEscrow,
} from './jup_lock';
import type { RealmPresaleStore } from './realm_presale';
import { fail, type RealmToken, type RealmTokenDb, type Result } from './realm_token';
import {
  allocationBps,
  bucketSchedule,
  canListRealmToken,
  computeAllocation,
  isLockBucket,
  type LockBucket,
  type LockParams,
  lockParams,
  lockTotalBase,
  tokenSupplyBase,
  U64_MAX,
} from './realm_token_alloc';
import { fetchFinalizedTransaction, type RawConfirmedTransaction, solanaRpc } from './solana_rpc';
import {
  fetchParsedMint,
  fetchRawAccountData,
  fetchTokenAccountBalanceBase,
  mintRugSummary,
  type ParsedMintInfo,
  parseToken2022Movement,
} from './solana_token2022';
import { isSolanaAddress } from './wallet_link';

const BASE58_SIG = /^[1-9A-HJ-NP-Za-km-z]{32,90}$/;
const MEMO_PROGRAM_ID = new PublicKey('MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr');
export const REALM_TOKEN_DECIMALS = 9;

// ── Quote persistence surface (realm_token_mint_db.ts implements) ────────────

export type LaunchQuoteKind = 'mint' | 'distribute' | 'lock';

export interface LaunchQuoteRow {
  quoteId: string;
  realmId: number;
  accountId: number;
  kind: LaunchQuoteKind;
  // Pinned facts only (pubkeys + base-unit strings). NEVER key material.
  payload: Record<string, unknown>;
  expiresAt: Date;
}

export interface LaunchQuoteStore {
  createQuote(q: LaunchQuoteRow): Promise<void>;
  getQuote(quoteId: string): Promise<LaunchQuoteRow | null>;
  deleteQuote(quoteId: string): Promise<void>;
}

// ── Chain seam (real RPC in production, fakes in tests, devnet in the dry-run) ─

export interface LaunchChain {
  fetchTx(sig: string): Promise<RawConfirmedTransaction | null>;
  fetchMint(mint: string): Promise<ParsedMintInfo | null>;
  fetchAccountData(address: string): Promise<Uint8Array | null>;
  fetchTokenBalanceBase(tokenAccount: string): Promise<bigint | null>;
  latestBlockhash(): Promise<string | null>;
  rentExemptLamports(space: number): Promise<number | null>;
}

export function realLaunchChain(): LaunchChain {
  return {
    fetchTx: (sig) => fetchFinalizedTransaction(sig),
    fetchMint: (mint) => fetchParsedMint(mint),
    fetchAccountData: (address) => fetchRawAccountData(address),
    fetchTokenBalanceBase: (tokenAccount) => fetchTokenAccountBalanceBase(tokenAccount),
    latestBlockhash: async () => {
      const res = await solanaRpc<{ value: { blockhash?: string } }>('getLatestBlockhash', [
        { commitment: 'finalized' },
      ]);
      const blockhash = res?.value?.blockhash;
      return typeof blockhash === 'string' ? blockhash : null;
    },
    rentExemptLamports: async (space) => {
      const res = await solanaRpc<number>('getMinimumBalanceForRentExemption', [space]);
      return typeof res === 'number' ? res : null;
    },
  };
}

export interface LaunchDeps {
  tokens: RealmTokenDb;
  quotes: LaunchQuoteStore;
  presales: Pick<RealmPresaleStore, 'getPresale'>;
  chain: LaunchChain;
  walletForAccount(accountId: number): Promise<{ pubkey: string } | null>;
  rolesForAccountOnRealm(realmId: number, accountId: number): Promise<string[]>;
  isUniqueViolation(err: unknown): boolean;
}

function intEnv(key: string, def: number, min: number, max: number): number {
  const v = Number.parseInt(process.env[key] ?? '', 10);
  return Number.isFinite(v) && v >= min && v <= max ? v : def;
}

function quoteTtlMs(): number {
  return intEnv('REALM_LAUNCH_QUOTE_TTL_MINUTES', 15, 1, 1440) * 60_000;
}

// The Levy Street Fund treasury wallet (PRD section 8): the recipient of every
// realm token's levy lock. Ops-owned configuration; the launch flow refuses to
// build a distribution while it is unset or malformed (fail closed, never
// default to a server key).
export function levyFundWallet(): string | null {
  const raw = (process.env.REALM_TOKEN_LEVY_WALLET ?? '').trim();
  return raw && isSolanaAddress(raw) ? raw : null;
}

// Shared guardrails for every launch step: owner-only, registered token, the
// launch runs only while the presale outcome is 'funded' (phase 4 moves it to
// 'live' after the locks are proven).
async function launchContext(
  deps: LaunchDeps,
  args: { accountId: number; realmId: number },
): Promise<Result<{ token: RealmToken; founderWallet: string }>> {
  const roles = await deps.rolesForAccountOnRealm(args.realmId, args.accountId);
  if (!roles.includes('owner')) return fail(403, 'not_realm_owner');
  const token = await deps.tokens.getRealmToken(args.realmId);
  if (!token) return fail(404, 'token_not_registered');
  if (token.status !== 'funded') return fail(409, 'mint_not_ready');
  const wallet = await deps.walletForAccount(args.accountId);
  if (!wallet) return fail(400, 'wallet_not_linked');
  return { ok: true, token, founderWallet: wallet.pubkey };
}

// ── Step 1: create the mint ───────────────────────────────────────────────────

export interface LaunchQuoteResponse {
  quoteId: string;
  realmId: number;
  txBase64: string;
  expiresAt: string;
}

export async function prepareMintQuote(
  deps: LaunchDeps,
  args: { accountId: number; realmId: number },
): Promise<Result<{ quote: LaunchQuoteResponse & { mint: string } }>> {
  const ctx = await launchContext(deps, args);
  if (!ctx.ok) return ctx;
  if (ctx.token.mint !== null) return fail(409, 'token_already_minted');
  if (levyFundWallet() === null) return fail(503, 'levy_wallet_unconfigured');

  const founder = new PublicKey(ctx.founderWallet);
  // TRANSIENT: generated here, signs the transaction below, then goes out of
  // scope. Never persisted, never returned; after this function only its
  // signature (bound to this exact message) survives.
  const mintKeypair = Keypair.generate();
  const mint = mintKeypair.publicKey;

  const metadata: TokenMetadata = {
    mint,
    name: ctx.token.symbol,
    symbol: ctx.token.symbol,
    uri: '',
    additionalMetadata: [],
  };
  const mintLen = getMintLen([ExtensionType.MetadataPointer]);
  const rentSpace = mintLen + TYPE_SIZE + LENGTH_SIZE + pack(metadata).length;
  const lamports = await deps.chain.rentExemptLamports(rentSpace);
  const blockhash = await deps.chain.latestBlockhash();
  if (lamports === null || blockhash === null) return fail(503, 'launch_unavailable');

  const quoteId = randomUUID();
  const tx = new Transaction();
  tx.recentBlockhash = blockhash;
  tx.feePayer = founder;
  tx.add(
    SystemProgram.createAccount({
      fromPubkey: founder,
      newAccountPubkey: mint,
      space: mintLen,
      lamports,
      programId: TOKEN_2022_PROGRAM_ID,
    }),
    // Immutable pointer (authority null) to the mint itself: metadata can
    // never be re-pointed at a different account.
    createInitializeMetadataPointerInstruction(mint, null, mint, TOKEN_2022_PROGRAM_ID),
    // Freeze authority is NEVER set; mint authority is the founder until the
    // distribute step renounces it.
    createInitializeMintInstruction(
      mint,
      REALM_TOKEN_DECIMALS,
      founder,
      null,
      TOKEN_2022_PROGRAM_ID,
    ),
    createInitializeInstruction({
      programId: TOKEN_2022_PROGRAM_ID,
      metadata: mint,
      updateAuthority: founder,
      mint,
      mintAuthority: founder,
      name: metadata.name,
      symbol: metadata.symbol,
      uri: metadata.uri,
    }),
    new TransactionInstruction({
      programId: MEMO_PROGRAM_ID,
      keys: [],
      data: Buffer.from(quoteId, 'utf8'),
    }),
  );
  tx.partialSign(mintKeypair);
  const txBase64 = tx
    .serialize({ requireAllSignatures: false, verifySignatures: false })
    .toString('base64');

  const expiresAt = new Date(Date.now() + quoteTtlMs());
  await deps.quotes.createQuote({
    quoteId,
    realmId: args.realmId,
    accountId: args.accountId,
    kind: 'mint',
    payload: { mint: mint.toBase58(), founderWallet: ctx.founderWallet, symbol: ctx.token.symbol },
    expiresAt,
  });
  return {
    ok: true,
    quote: {
      quoteId,
      realmId: args.realmId,
      txBase64,
      mint: mint.toBase58(),
      expiresAt: expiresAt.toISOString(),
    },
  };
}

// Verify the finalized creation transaction and the resulting on-chain mint
// state, then record mint + launch_tx_sig (UNIQUE replay guard).
export async function confirmMintCreated(
  deps: LaunchDeps,
  args: { accountId: number; quoteId: string; signature: string },
): Promise<Result<{ mint: string }>> {
  const quote = await deps.quotes.getQuote(args.quoteId);
  if (!quote || quote.kind !== 'mint') return fail(404, 'quote_not_found');
  if (quote.accountId !== args.accountId) return fail(403, 'not_your_quote');
  if (quote.expiresAt.getTime() <= Date.now()) return fail(410, 'quote_expired');
  if (!BASE58_SIG.test(args.signature)) return fail(400, 'bad_signature');

  const mint = String(quote.payload.mint ?? '');
  const founderWallet = String(quote.payload.founderWallet ?? '');
  const symbol = String(quote.payload.symbol ?? '');

  const tx = await deps.chain.fetchTx(args.signature);
  if (!tx) return fail(409, 'not_finalized');
  const movement = parseToken2022Movement(tx, mint);
  if (!movement.succeeded) return fail(400, 'tx_failed');
  if (movement.memo !== args.quoteId) return fail(400, 'memo_mismatch');
  if (movement.feePayer !== founderWallet) return fail(400, 'wrong_payer');

  const parsed = await deps.chain.fetchMint(mint);
  if (!parsed) return fail(409, 'not_finalized');
  const summary = mintRugSummary(mint, parsed);
  if (
    parsed.program !== 'spl-token-2022' ||
    parsed.decimals !== REALM_TOKEN_DECIMALS ||
    parsed.supplyBase !== 0n ||
    parsed.mintAuthority !== founderWallet || // renounced at distribute, not yet
    parsed.freezeAuthority !== null ||
    parsed.metadata?.symbol !== symbol ||
    !summary.metadataPointerSelf ||
    summary.forbiddenExtensions.length > 0
  ) {
    return fail(400, 'mint_mismatch');
  }

  let recorded: RealmToken | null;
  try {
    recorded = await deps.tokens.recordMintCreated(quote.realmId, mint, args.signature);
  } catch (err) {
    if (deps.isUniqueViolation(err)) return fail(409, 'launch_sig_reused');
    throw err;
  }
  if (!recorded) return fail(409, 'token_already_minted');
  await deps.quotes.deleteQuote(args.quoteId);
  return { ok: true, mint };
}

// ── Step 2: distribute the fixed supply + renounce ────────────────────────────

interface DistributePayload {
  mint: string;
  founderWallet: string;
  escrowWallet: string;
  supplyBase: string;
  publicCurveBase: string;
  liquidityBase: string;
  founderBase: string;
  levyBase: string;
  treasuryBase: string;
}

export async function prepareDistributionQuote(
  deps: LaunchDeps,
  args: { accountId: number; realmId: number },
): Promise<Result<{ quote: LaunchQuoteResponse }>> {
  const ctx = await launchContext(deps, args);
  if (!ctx.ok) return ctx;
  if (ctx.token.mint === null) return fail(409, 'token_not_minted');
  if (ctx.token.distributeTxSig !== null) return fail(409, 'already_distributed');
  if (levyFundWallet() === null) return fail(503, 'levy_wallet_unconfigured');
  const presale = await deps.presales.getPresale(args.realmId);
  if (!presale) return fail(409, 'presale_not_configured');

  const supplyBase = tokenSupplyBase();
  const alloc = computeAllocation(supplyBase, allocationBps());
  if (supplyBase > U64_MAX) return fail(503, 'launch_unavailable');

  const founder = new PublicKey(ctx.founderWallet);
  const mint = new PublicKey(ctx.token.mint);
  const escrowOwner = new PublicKey(presale.escrowWallet);
  const escrowAta = getAssociatedTokenAddressSync(mint, escrowOwner, true, TOKEN_2022_PROGRAM_ID);
  const founderAta = getAssociatedTokenAddressSync(mint, founder, false, TOKEN_2022_PROGRAM_ID);
  const curveBase = alloc.publicCurveBase + alloc.liquidityBase;
  const lockedBase = alloc.founderBase + alloc.levyBase + alloc.treasuryBase;

  const blockhash = await deps.chain.latestBlockhash();
  if (blockhash === null) return fail(503, 'launch_unavailable');

  const quoteId = randomUUID();
  const tx = new Transaction();
  tx.recentBlockhash = blockhash;
  tx.feePayer = founder;
  tx.add(
    createAssociatedTokenAccountIdempotentInstruction(
      founder,
      escrowAta,
      escrowOwner,
      mint,
      TOKEN_2022_PROGRAM_ID,
    ),
    createMintToCheckedInstruction(
      mint,
      escrowAta,
      founder,
      curveBase,
      REALM_TOKEN_DECIMALS,
      [],
      TOKEN_2022_PROGRAM_ID,
    ),
    createAssociatedTokenAccountIdempotentInstruction(
      founder,
      founderAta,
      founder,
      mint,
      TOKEN_2022_PROGRAM_ID,
    ),
    createMintToCheckedInstruction(
      mint,
      founderAta,
      founder,
      lockedBase,
      REALM_TOKEN_DECIMALS,
      [],
      TOKEN_2022_PROGRAM_ID,
    ),
    // Renounce IN THE SAME transaction as the distribution: the supply is
    // fixed and the metadata frozen the instant the last bucket lands.
    createSetAuthorityInstruction(
      mint,
      founder,
      AuthorityType.MintTokens,
      null,
      [],
      TOKEN_2022_PROGRAM_ID,
    ),
    createUpdateAuthorityInstruction({
      programId: TOKEN_2022_PROGRAM_ID,
      metadata: mint,
      oldAuthority: founder,
      newAuthority: null,
    }),
    new TransactionInstruction({
      programId: MEMO_PROGRAM_ID,
      keys: [],
      data: Buffer.from(quoteId, 'utf8'),
    }),
  );
  const txBase64 = tx
    .serialize({ requireAllSignatures: false, verifySignatures: false })
    .toString('base64');

  const payload: DistributePayload = {
    mint: ctx.token.mint,
    founderWallet: ctx.founderWallet,
    escrowWallet: presale.escrowWallet,
    supplyBase: supplyBase.toString(),
    publicCurveBase: alloc.publicCurveBase.toString(),
    liquidityBase: alloc.liquidityBase.toString(),
    founderBase: alloc.founderBase.toString(),
    levyBase: alloc.levyBase.toString(),
    treasuryBase: alloc.treasuryBase.toString(),
  };
  const expiresAt = new Date(Date.now() + quoteTtlMs());
  await deps.quotes.createQuote({
    quoteId,
    realmId: args.realmId,
    accountId: args.accountId,
    kind: 'distribute',
    payload: payload as unknown as Record<string, unknown>,
    expiresAt,
  });
  return {
    ok: true,
    quote: { quoteId, realmId: args.realmId, txBase64, expiresAt: expiresAt.toISOString() },
  };
}

export async function confirmDistribution(
  deps: LaunchDeps,
  args: { accountId: number; quoteId: string; signature: string },
): Promise<Result<{ distributed: true }>> {
  const quote = await deps.quotes.getQuote(args.quoteId);
  if (!quote || quote.kind !== 'distribute') return fail(404, 'quote_not_found');
  if (quote.accountId !== args.accountId) return fail(403, 'not_your_quote');
  if (quote.expiresAt.getTime() <= Date.now()) return fail(410, 'quote_expired');
  if (!BASE58_SIG.test(args.signature)) return fail(400, 'bad_signature');
  const p = quote.payload as unknown as DistributePayload;

  const tx = await deps.chain.fetchTx(args.signature);
  if (!tx) return fail(409, 'not_finalized');
  const movement = parseToken2022Movement(tx, p.mint);
  if (!movement.succeeded) return fail(400, 'tx_failed');
  if (movement.sawForeignProgramForMint) return fail(400, 'mint_mismatch');
  if (movement.memo !== args.quoteId) return fail(400, 'memo_mismatch');
  if (movement.feePayer !== p.founderWallet) return fail(400, 'wrong_payer');

  // Exact per-owner expectations (escrow and founder may be the same wallet,
  // in which case one combined delta is expected).
  const expected = new Map<string, bigint>();
  const add = (owner: string, amount: bigint) =>
    expected.set(owner, (expected.get(owner) ?? 0n) + amount);
  add(p.escrowWallet, BigInt(p.publicCurveBase) + BigInt(p.liquidityBase));
  add(p.founderWallet, BigInt(p.founderBase) + BigInt(p.levyBase) + BigInt(p.treasuryBase));
  if (movement.tokenDeltas.size !== expected.size) return fail(400, 'distribution_mismatch');
  for (const [owner, amount] of expected) {
    if (movement.tokenDeltas.get(owner) !== amount) return fail(400, 'distribution_mismatch');
  }

  // Post-state: fixed supply, EVERY authority renounced, scanner-clean.
  const parsed = await deps.chain.fetchMint(p.mint);
  if (!parsed) return fail(409, 'not_finalized');
  const summary = mintRugSummary(p.mint, parsed);
  if (parsed.supplyBase !== BigInt(p.supplyBase) || !summary.clean) {
    return fail(400, 'distribution_mismatch');
  }

  let recorded: RealmToken | null;
  try {
    recorded = await deps.tokens.recordDistribution(quote.realmId, {
      distributeTxSig: args.signature,
      supplyBase: BigInt(p.supplyBase),
      founderAllocBase: BigInt(p.founderBase),
      levyAllocBase: BigInt(p.levyBase),
      treasuryAllocBase: BigInt(p.treasuryBase),
    });
  } catch (err) {
    if (deps.isUniqueViolation(err)) return fail(409, 'launch_sig_reused');
    throw err;
  }
  if (!recorded) return fail(409, 'already_distributed');
  await deps.quotes.deleteQuote(args.quoteId);
  return { ok: true, distributed: true };
}

// ── Step 3: the immutable Jupiter Lock escrows ────────────────────────────────

interface LockPayload {
  bucket: LockBucket;
  mint: string;
  founderWallet: string;
  escrow: string;
  recipient: string;
  amountBase: string;
  vestingStartTime: string;
  cliffTime: string;
  frequency: string;
  cliffUnlockAmount: string;
  amountPerPeriod: string;
  numberOfPeriod: string;
}

function bucketAlloc(token: RealmToken, bucket: LockBucket): bigint | null {
  switch (bucket) {
    case 'founder':
      return token.founderAllocBase;
    case 'levy':
      return token.levyAllocBase;
    case 'treasury':
      return token.treasuryAllocBase;
  }
}

function bucketLockAddress(token: RealmToken, bucket: LockBucket): string | null {
  switch (bucket) {
    case 'founder':
      return token.founderLockAddress;
    case 'levy':
      return token.levyLockAddress;
    case 'treasury':
      return token.treasuryLockAddress;
  }
}

// The lock recipient per bucket: the founder's vested allocation and the realm
// treasury both vest to the founder wallet (the treasury is the realm
// operator's operations budget, PRD section 7); the levy bucket vests to the
// platform's Levy Street Fund wallet.
function bucketRecipient(bucket: LockBucket, founderWallet: string): string | null {
  if (bucket === 'levy') return levyFundWallet();
  return founderWallet;
}

export async function prepareLockQuote(
  deps: LaunchDeps,
  args: { accountId: number; realmId: number; bucket: string },
): Promise<Result<{ quote: LaunchQuoteResponse & { bucket: LockBucket; escrow: string } }>> {
  if (!isLockBucket(args.bucket)) return fail(400, 'invalid_lock_bucket');
  const ctx = await launchContext(deps, args);
  if (!ctx.ok) return ctx;
  if (ctx.token.mint === null) return fail(409, 'token_not_minted');
  if (ctx.token.distributeTxSig === null) return fail(409, 'not_distributed');
  if (bucketLockAddress(ctx.token, args.bucket) !== null) return fail(409, 'already_locked');
  const amountBase = bucketAlloc(ctx.token, args.bucket);
  if (amountBase === null || amountBase <= 0n) return fail(409, 'not_distributed');
  const recipient = bucketRecipient(args.bucket, ctx.founderWallet);
  if (recipient === null) return fail(503, 'levy_wallet_unconfigured');

  const blockhash = await deps.chain.latestBlockhash();
  if (blockhash === null) return fail(503, 'launch_unavailable');

  const founder = new PublicKey(ctx.founderWallet);
  const mint = new PublicKey(ctx.token.mint);
  // TRANSIENT, like the mint keypair: only namespaces the escrow PDA and
  // co-signs this one transaction; it holds no authority afterward.
  const baseKeypair = Keypair.generate();
  const escrow = deriveEscrowPda(baseKeypair.publicKey);
  const params = lockParams(amountBase, bucketSchedule(args.bucket), Math.floor(Date.now() / 1000));

  const escrowAta = escrowTokenAta(escrow, mint, TOKEN_2022_PROGRAM_ID);
  const tx = new Transaction();
  tx.recentBlockhash = blockhash;
  tx.feePayer = founder;
  tx.add(
    // The deployed lock program expects the escrow's token account to already
    // exist (it does not init it), so the founder creates the PDA-owned ATA in
    // the same transaction.
    createAssociatedTokenAccountIdempotentInstruction(
      founder,
      escrowAta,
      escrow,
      mint,
      TOKEN_2022_PROGRAM_ID,
    ),
    buildCreateVestingEscrowV2Ix({
      base: baseKeypair.publicKey,
      sender: founder,
      senderToken: getAssociatedTokenAddressSync(mint, founder, false, TOKEN_2022_PROGRAM_ID),
      recipient: new PublicKey(recipient),
      mint,
      tokenProgram: TOKEN_2022_PROGRAM_ID,
      params,
    }),
  );
  tx.partialSign(baseKeypair);
  const txBase64 = tx
    .serialize({ requireAllSignatures: false, verifySignatures: false })
    .toString('base64');

  const quoteId = randomUUID();
  const payload: LockPayload = {
    bucket: args.bucket,
    mint: ctx.token.mint,
    founderWallet: ctx.founderWallet,
    escrow: escrow.toBase58(),
    recipient,
    amountBase: amountBase.toString(),
    vestingStartTime: params.vestingStartTime.toString(),
    cliffTime: params.cliffTime.toString(),
    frequency: params.frequency.toString(),
    cliffUnlockAmount: params.cliffUnlockAmount.toString(),
    amountPerPeriod: params.amountPerPeriod.toString(),
    numberOfPeriod: params.numberOfPeriod.toString(),
  };
  const expiresAt = new Date(Date.now() + quoteTtlMs());
  await deps.quotes.createQuote({
    quoteId,
    realmId: args.realmId,
    accountId: args.accountId,
    kind: 'lock',
    payload: payload as unknown as Record<string, unknown>,
    expiresAt,
  });
  return {
    ok: true,
    quote: {
      quoteId,
      realmId: args.realmId,
      txBase64,
      bucket: args.bucket,
      escrow: escrow.toBase58(),
      expiresAt: expiresAt.toISOString(),
    },
  };
}

// Verify the escrow ACCOUNT STATE (stronger than the transaction: the decoded
// escrow must carry exactly the pinned mint / recipient / immutability /
// vesting numbers, and its token account must hold the full locked amount),
// then record the address.
export async function confirmLock(
  deps: LaunchDeps,
  args: { accountId: number; quoteId: string },
): Promise<Result<{ bucket: LockBucket; escrow: string }>> {
  const quote = await deps.quotes.getQuote(args.quoteId);
  if (!quote || quote.kind !== 'lock') return fail(404, 'quote_not_found');
  if (quote.accountId !== args.accountId) return fail(403, 'not_your_quote');
  if (quote.expiresAt.getTime() <= Date.now()) return fail(410, 'quote_expired');
  const p = quote.payload as unknown as LockPayload;
  if (!isLockBucket(p.bucket)) return fail(400, 'invalid_lock_bucket');

  const data = await deps.chain.fetchAccountData(p.escrow);
  if (!data) return fail(409, 'not_finalized');
  const escrow = decodeVestingEscrow(data);
  if (!escrow) return fail(400, 'lock_mismatch');
  const params: LockParams = {
    vestingStartTime: BigInt(p.vestingStartTime),
    cliffTime: BigInt(p.cliffTime),
    frequency: BigInt(p.frequency),
    cliffUnlockAmount: BigInt(p.cliffUnlockAmount),
    amountPerPeriod: BigInt(p.amountPerPeriod),
    numberOfPeriod: BigInt(p.numberOfPeriod),
  };
  const verdict = verifyLockedEscrow(escrow, { mint: p.mint, recipient: p.recipient, params });
  if (!verdict.ok) return fail(400, verdict.reason);
  if (lockTotalBase(escrow) !== BigInt(p.amountBase)) return fail(400, 'lock_mismatch');

  const ata = escrowTokenAta(new PublicKey(p.escrow), new PublicKey(p.mint), TOKEN_2022_PROGRAM_ID);
  const balance = await deps.chain.fetchTokenBalanceBase(ata.toBase58());
  if (balance === null || balance < BigInt(p.amountBase)) return fail(400, 'lock_underfunded');

  const recorded = await deps.tokens.recordLockAddress(quote.realmId, p.bucket, p.escrow);
  if (!recorded) return fail(409, 'already_locked');
  await deps.quotes.deleteQuote(args.quoteId);
  return { ok: true, bucket: p.bucket, escrow: p.escrow };
}

// ── Listing gate + launch status ──────────────────────────────────────────────

// The ONLY door to 'live' (PRD section 7): the founder, levy, and LP locks
// must all be recorded (each recorded only after on-chain verification) before
// the status CAS can run. Phase 4 calls this after the curve exists.
export async function markTokenLive(
  deps: Pick<LaunchDeps, 'tokens'>,
  realmId: number,
): Promise<Result<{ status: RealmToken['status'] }>> {
  const token = await deps.tokens.getRealmToken(realmId);
  if (!token) return fail(404, 'token_not_registered');
  if (!canListRealmToken(token)) return fail(409, 'locks_incomplete');
  const flipped = await deps.tokens.setRealmTokenStatus(realmId, ['funded'], 'live');
  if (!flipped) return fail(409, 'mint_not_ready');
  return { ok: true, status: flipped.status };
}

// The launch panel / dry-run read: where the launch stands, bucket by bucket.
export interface LaunchStatusInfo {
  status: RealmToken['status'];
  mint: string | null;
  launchTxSig: string | null;
  distributeTxSig: string | null;
  supplyBase: string | null;
  locks: Record<LockBucket, { address: string | null; allocBase: string | null }>;
  lpLockAddress: string | null;
  canList: boolean;
  levyWalletConfigured: boolean;
}

export async function launchStatus(
  deps: Pick<LaunchDeps, 'tokens'>,
  realmId: number,
): Promise<Result<{ launch: LaunchStatusInfo }>> {
  const token = await deps.tokens.getRealmToken(realmId);
  if (!token) return fail(404, 'token_not_registered');
  return {
    ok: true,
    launch: {
      status: token.status,
      mint: token.mint,
      launchTxSig: token.launchTxSig,
      distributeTxSig: token.distributeTxSig,
      supplyBase: token.supplyBase === null ? null : token.supplyBase.toString(),
      locks: {
        founder: {
          address: token.founderLockAddress,
          allocBase: token.founderAllocBase === null ? null : token.founderAllocBase.toString(),
        },
        levy: {
          address: token.levyLockAddress,
          allocBase: token.levyAllocBase === null ? null : token.levyAllocBase.toString(),
        },
        treasury: {
          address: token.treasuryLockAddress,
          allocBase: token.treasuryAllocBase === null ? null : token.treasuryAllocBase.toString(),
        },
      },
      lpLockAddress: token.lpLockAddress,
      canList: canListRealmToken(token),
      levyWalletConfigured: levyFundWallet() !== null,
    },
  };
}
