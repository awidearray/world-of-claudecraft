// Token-2022 mint factory (launchpad phase 3, PRD sections 5.2, 5.9, 7).
//
// The fair-launch pipeline after a funded presale:
//
//   prepare  -> the server pins the launch (supply, allocation snapshot, the
//               levy/treasury recipients) and builds ONE create-mint
//               transaction in the boring metadata-only Token-2022 profile
//               (9 decimals, freeze authority null, metadata pointer to the
//               mint itself with a null pointer authority). The server
//               partial-signs with a TRANSIENT mint keypair (the keypair IS
//               the mint address; it signs account creation and is discarded
//               before this function returns) and the FOUNDER co-signs and
//               pays rent. The founder wallet is the mint authority, so the
//               server never holds an authority key at any point.
//   confirm  -> the server fetches the finalized creation transaction and the
//               live mint account and verifies the profile on-chain, then
//               records mint + launch_tx_sig (UNIQUE replay guard).
//   verify   -> the founder distributes the fixed supply and creates the three
//               IMMUTABLE Jupiter Lock escrows (founder / Levy Street Fund /
//               realm treasury); the server verifies EVERYTHING against the
//               chain: exact supply, renounced mint authority, and each lock's
//               recipient, amount, immutability, schedule, and funding.
//   list     -> phase 4 may flip `funded -> live` ONLY once the locks are
//               verified and a curve exists (launchReadyToList). A token
//               physically cannot list before its locks are on-chain.
//
// Non-custodial: the server builds and VERIFIES; the founder signs and pays.
// The only key material the server ever touches is the transient mint-account
// keypair inside prepareMintCreate, which cannot move funds and is never
// persisted. No SQL here (realm_token_db.ts owns the launch table).

import {
  createInitializeMetadataPointerInstruction,
  createInitializeMintInstruction,
  ExtensionType,
  getMintLen,
  LENGTH_SIZE,
  TOKEN_2022_PROGRAM_ID,
  TYPE_SIZE,
} from '@solana/spl-token';
import { createInitializeInstruction, pack, type TokenMetadata } from '@solana/spl-token-metadata';
import { Keypair, PublicKey, SystemProgram, Transaction } from '@solana/web3.js';
import { fail, type RealmToken, type RealmTokenDb, type Result } from './realm_token';
import {
  type AllocationBps,
  type LockedBucket,
  MONTH_SECONDS,
  REALM_TOKEN_DECIMALS,
  realmTokenSupplyBase,
  resolveAllocationBps,
  type SupplySplit,
  splitSupplyBase,
  vestingScheduleFor,
} from './realm_token_alloc';
import type { RawConfirmedTransaction } from './solana_rpc';
import { fetchFinalizedTransaction, SPL_TOKEN_2022_PROGRAM, solanaRpc } from './solana_rpc';
import {
  fetchToken2022MintState,
  fetchToken2022OwnedBalance,
  fetchVestingEscrow,
  LOCK_MODE_NEITHER,
  LOCK_TOKEN_PROGRAM_2022,
  type Token2022MintState,
  type VestingEscrowState,
} from './token2022_verify';
import { isSolanaAddress } from './wallet_link';

const BASE58_SIG = /^[1-9A-HJ-NP-Za-km-z]{32,90}$/;
// Token-2022 metadata: printable-ASCII name up to 32 chars; https metadata uri
// up to 200 chars (or empty: the metadata is then symbol + name only).
const NAME_RE = /^[\x20-\x7E]{1,32}$/;
const URI_RE = /^https:\/\/[\x21-\x7E]{8,192}$/;

// The Levy Street Fund treasury wallet (PRD section 8): the platform-owned
// recipient of every realm token's levy lock. Ops-owned configuration; the
// mint factory is unavailable until it is set (fail-closed, like the wager
// feature gates).
export function levyFundWallet(): string | null {
  const raw = (process.env.LEVY_FUND_WALLET ?? '').trim();
  return isSolanaAddress(raw) ? raw : null;
}

// ── Launch persistence surface (SQL in realm_token_db.ts) ────────────────────

export interface RealmTokenLaunch {
  realmId: number;
  pendingMint: string;
  supplyBase: bigint;
  alloc: AllocationBps;
  founderWallet: string;
  levyWallet: string;
  treasuryWallet: string;
  founderLockAddress: string | null;
  levyLockAddress: string | null;
  treasuryLockAddress: string | null;
  mintConfirmedAt: Date | null;
  locksVerifiedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface RealmTokenLaunchStore {
  getLaunch(realmId: number): Promise<RealmTokenLaunch | null>;
  // Insert or replace the pending launch. Returns false once the mint is
  // confirmed (a confirmed launch is immutable).
  upsertPendingLaunch(l: {
    realmId: number;
    pendingMint: string;
    supplyBase: bigint;
    alloc: AllocationBps;
    founderWallet: string;
    levyWallet: string;
    treasuryWallet: string;
  }): Promise<boolean>;
  // Atomically set realm_tokens.mint + launch_tx_sig (only while mint IS NULL)
  // and stamp the launch confirmed. False when the mint was already recorded;
  // a replayed signature or reused mint surfaces as a unique violation.
  recordMintCreated(realmId: number, mint: string, launchTxSig: string): Promise<boolean>;
  // Pin the three lock escrow addresses (only after mint confirm and before
  // locks verify). False when the launch is not in that window.
  setLockAddresses(
    realmId: number,
    locks: { founder: string; levy: string; treasury: string },
  ): Promise<boolean>;
  markLocksVerified(realmId: number): Promise<boolean>;
}

// The chain surface the factory verifies against; injected so tests drive the
// whole pipeline with fixture states and the live wiring binds the
// token2022_verify.ts / solana_rpc.ts readers.
export interface LaunchChainReader {
  fetchTx(sig: string): Promise<RawConfirmedTransaction | null>;
  fetchMintState(mint: string): Promise<Token2022MintState | null>;
  fetchVestingEscrow(address: string): Promise<VestingEscrowState | null>;
  fetchOwnedBalance(mint: string, owner: string): Promise<bigint | null>;
  latestBlockhash(): Promise<string | null>;
  minRentLamports(space: number): Promise<bigint | null>;
}

export interface MintDeps {
  tokens: RealmTokenDb;
  launches: RealmTokenLaunchStore;
  chain: LaunchChainReader;
  walletForAccount(accountId: number): Promise<{ pubkey: string } | null>;
  rolesForAccountOnRealm(realmId: number, accountId: number): Promise<string[]>;
  isUniqueViolation(err: unknown): boolean;
}

// The production chain reader: the token2022_verify.ts fetchers plus the two
// build-time RPC reads (blockhash + rent). Tests inject fixture readers.
export function liveLaunchChainReader(): LaunchChainReader {
  return {
    fetchTx: (sig) => fetchFinalizedTransaction(sig),
    fetchMintState: (mint) => fetchToken2022MintState(mint),
    fetchVestingEscrow: (address) => fetchVestingEscrow(address),
    fetchOwnedBalance: (mint, owner) => fetchToken2022OwnedBalance(mint, owner),
    latestBlockhash: async () => {
      const res = await solanaRpc<{ value?: { blockhash?: string } }>('getLatestBlockhash', [
        { commitment: 'finalized' },
      ]);
      const blockhash = res?.value?.blockhash;
      return typeof blockhash === 'string' && blockhash.length > 0 ? blockhash : null;
    },
    minRentLamports: async (space) => {
      const res = await solanaRpc<number>('getMinimumBalanceForRentExemption', [space]);
      return typeof res === 'number' && Number.isFinite(res) ? BigInt(Math.trunc(res)) : null;
    },
  };
}

// ── Prepare: build the partial-signed create-mint transaction ────────────────

export interface BucketTerms {
  bucket: LockedBucket;
  recipient: string;
  amountBase: string;
  cliffMonths: number;
  linearMonths: number;
  frequencySeconds: string;
  cliffUnlockAmount: string;
  amountPerPeriod: string;
  numberOfPeriod: string;
}

export interface MintPrepareResponse {
  txBase64: string;
  mint: string;
  supplyBase: string;
  alloc: AllocationBps;
  split: Record<keyof SupplySplit, string>;
  lockTerms: BucketTerms[];
}

function lockTermsFor(launch: {
  alloc: AllocationBps;
  supplyBase: bigint;
  founderWallet: string;
  levyWallet: string;
  treasuryWallet: string;
}): BucketTerms[] {
  const split = splitSupplyBase(launch.supplyBase, launch.alloc);
  const buckets: Array<{ bucket: LockedBucket; recipient: string; amountBase: bigint }> = [
    { bucket: 'founder', recipient: launch.founderWallet, amountBase: split.founderBase },
    { bucket: 'levy', recipient: launch.levyWallet, amountBase: split.levyBase },
    { bucket: 'treasury', recipient: launch.treasuryWallet, amountBase: split.treasuryBase },
  ];
  return buckets.map(({ bucket, recipient, amountBase }) => {
    const s = vestingScheduleFor(bucket, amountBase);
    return {
      bucket,
      recipient,
      amountBase: amountBase.toString(),
      cliffMonths: s.cliffMonths,
      linearMonths: s.linearMonths,
      frequencySeconds: s.frequency.toString(),
      cliffUnlockAmount: s.cliffUnlockAmount.toString(),
      amountPerPeriod: s.amountPerPeriod.toString(),
      numberOfPeriod: s.numberOfPeriod.toString(),
    };
  });
}

// Build the one create-mint transaction and pin the launch snapshot. The
// transient mint keypair partial-signs (it IS the new account) and goes out of
// scope here; the founder signs as fee payer and submits. Re-preparing is
// allowed (and generates a fresh mint address) until the mint is confirmed.
export async function prepareMintCreate(
  deps: MintDeps,
  args: {
    accountId: number;
    realmId: number;
    treasuryWallet: string;
    name?: string;
    uri?: string;
  },
): Promise<Result<MintPrepareResponse>> {
  const roles = await deps.rolesForAccountOnRealm(args.realmId, args.accountId);
  if (!roles.includes('owner')) return fail(403, 'not_realm_owner');
  const token = await deps.tokens.getRealmToken(args.realmId);
  if (!token) return fail(404, 'token_not_registered');
  if (token.mint !== null) return fail(409, 'mint_already_created');
  if (token.status !== 'funded') return fail(409, 'presale_not_funded');

  const founder = await deps.walletForAccount(args.accountId);
  if (!founder) return fail(400, 'wallet_not_linked');
  const levyWallet = levyFundWallet();
  if (!levyWallet) return fail(503, 'levy_fund_unconfigured');
  if (!isSolanaAddress(args.treasuryWallet)) return fail(400, 'invalid_treasury_wallet');

  const name = (args.name ?? token.symbol).trim();
  if (!NAME_RE.test(name)) return fail(400, 'invalid_token_name');
  const uri = (args.uri ?? '').trim();
  if (uri !== '' && !URI_RE.test(uri)) return fail(400, 'invalid_token_uri');

  const supplyBase = realmTokenSupplyBase();
  const alloc = resolveAllocationBps();

  const blockhash = await deps.chain.latestBlockhash();
  if (!blockhash) return fail(503, 'chain_unavailable');

  const mintKeypair = Keypair.generate();
  const mintPubkey = mintKeypair.publicKey;
  const founderPubkey = new PublicKey(founder.pubkey);

  const metadata: TokenMetadata = {
    mint: mintPubkey,
    name,
    symbol: token.symbol,
    uri,
    additionalMetadata: [],
  };
  const mintLen = getMintLen([ExtensionType.MetadataPointer]);
  const metadataLen = TYPE_SIZE + LENGTH_SIZE + pack(metadata).length;
  const rent = await deps.chain.minRentLamports(mintLen + metadataLen);
  if (rent === null) return fail(503, 'chain_unavailable');

  const tx = new Transaction();
  tx.feePayer = founderPubkey;
  tx.recentBlockhash = blockhash;
  tx.add(
    // The account is sized for the mint + metadata-pointer extension only; the
    // token program reallocs for the metadata itself from the rent excess.
    SystemProgram.createAccount({
      fromPubkey: founderPubkey,
      newAccountPubkey: mintPubkey,
      space: mintLen,
      lamports: Number(rent),
      programId: TOKEN_2022_PROGRAM_ID,
    }),
    // Pointer to the mint itself with NO pointer authority: the metadata
    // location can never be repointed at a different account.
    createInitializeMetadataPointerInstruction(mintPubkey, null, mintPubkey, TOKEN_2022_PROGRAM_ID),
    // Mint authority = the founder (renounced after distribution, verified at
    // listing); freeze authority NEVER set.
    createInitializeMintInstruction(
      mintPubkey,
      REALM_TOKEN_DECIMALS,
      founderPubkey,
      null,
      TOKEN_2022_PROGRAM_ID,
    ),
    createInitializeInstruction({
      programId: TOKEN_2022_PROGRAM_ID,
      metadata: mintPubkey,
      updateAuthority: founderPubkey,
      mint: mintPubkey,
      mintAuthority: founderPubkey,
      name,
      symbol: token.symbol,
      uri,
    }),
  );
  tx.partialSign(mintKeypair);
  const txBase64 = tx
    .serialize({ requireAllSignatures: false, verifySignatures: false })
    .toString('base64');

  const pinned = {
    realmId: args.realmId,
    pendingMint: mintPubkey.toBase58(),
    supplyBase,
    alloc,
    founderWallet: founder.pubkey,
    levyWallet,
    treasuryWallet: args.treasuryWallet,
  };
  if (!(await deps.launches.upsertPendingLaunch(pinned))) {
    return fail(409, 'mint_already_created'); // lost the race to a confirm
  }

  const split = splitSupplyBase(supplyBase, alloc);
  return {
    ok: true,
    txBase64,
    mint: pinned.pendingMint,
    supplyBase: supplyBase.toString(),
    alloc,
    split: {
      publicBase: split.publicBase.toString(),
      liquidityBase: split.liquidityBase.toString(),
      founderBase: split.founderBase.toString(),
      levyBase: split.levyBase.toString(),
      treasuryBase: split.treasuryBase.toString(),
    },
    lockTerms: lockTermsFor(pinned),
  };
}

// ── Confirm: verify the finalized creation on-chain, record the mint ─────────

// The boring-profile mint checks shared by confirm (pre-distribution) and the
// launch verification (post-distribution). PURE.
export type MintProfileIssue =
  | 'wrong_token_program'
  | 'wrong_decimals'
  | 'freeze_authority_set'
  | 'bad_metadata_pointer'
  | 'metadata_symbol_mismatch'
  | 'unexpected_extension';

export function mintProfileIssues(
  state: Token2022MintState,
  expected: { mint: string; symbol: string },
): MintProfileIssue[] {
  const issues: MintProfileIssue[] = [];
  if (state.ownerProgram !== SPL_TOKEN_2022_PROGRAM) issues.push('wrong_token_program');
  if (state.decimals !== REALM_TOKEN_DECIMALS) issues.push('wrong_decimals');
  if (state.freezeAuthority !== null) issues.push('freeze_authority_set');
  if (
    !state.metadataPointer ||
    state.metadataPointer.metadataAddress !== expected.mint ||
    state.metadataPointer.authority !== null
  ) {
    issues.push('bad_metadata_pointer');
  }
  if (!state.tokenMetadata || state.tokenMetadata.symbol !== expected.symbol) {
    issues.push('metadata_symbol_mismatch');
  }
  if (state.extraExtensions.length > 0) issues.push('unexpected_extension');
  return issues;
}

export async function confirmMintCreate(
  deps: MintDeps,
  args: { accountId: number; realmId: number; sig: string },
): Promise<Result<{ mint: string }>> {
  const roles = await deps.rolesForAccountOnRealm(args.realmId, args.accountId);
  if (!roles.includes('owner')) return fail(403, 'not_realm_owner');
  const token = await deps.tokens.getRealmToken(args.realmId);
  if (!token) return fail(404, 'token_not_registered');
  if (token.mint !== null) return fail(409, 'mint_already_created');
  const launch = await deps.launches.getLaunch(args.realmId);
  if (!launch) return fail(409, 'launch_not_prepared');
  if (!BASE58_SIG.test(args.sig)) return fail(400, 'bad_signature');

  const tx = await deps.chain.fetchTx(args.sig);
  if (!tx) return fail(400, 'not_finalized');
  if (tx.meta == null || tx.meta.err != null) return fail(400, 'tx_failed');
  const keys = tx.transaction.message.accountKeys.map((k) =>
    typeof k === 'string' ? k : k.pubkey,
  );
  if (keys.length === 0 || keys[0] !== launch.founderWallet) return fail(400, 'wrong_payer');
  if (!keys.includes(launch.pendingMint)) return fail(400, 'mint_not_in_tx');

  const state = await deps.chain.fetchMintState(launch.pendingMint);
  if (!state) return fail(400, 'mint_not_found');
  const issues = mintProfileIssues(state, { mint: launch.pendingMint, symbol: token.symbol });
  if (issues.length > 0) return fail(400, issues[0]);

  try {
    if (!(await deps.launches.recordMintCreated(args.realmId, launch.pendingMint, args.sig))) {
      return fail(409, 'mint_already_created');
    }
  } catch (err) {
    if (deps.isUniqueViolation(err)) return fail(409, 'launch_sig_replayed');
    throw err;
  }
  return { ok: true, mint: launch.pendingMint };
}

// ── Verify: distribution + immutable locks, all against the chain ────────────

// One verification check. `detail` is terse key=value diagnostic DATA (never
// prose): the client localizes the check NAME and renders the detail verbatim
// as data, so the server stays language-agnostic.
export interface LaunchCheck {
  check: string;
  ok: boolean;
  detail: string;
}

// Grace window on the cliff check: verification can run a few days after the
// locks were created, so "12 months from now" tolerates the gap without ever
// accepting a backdated cliff.
const CLIFF_GRACE_SECONDS = 7n * 86_400n;

function escrowChecks(args: {
  label: LockedBucket;
  escrow: VestingEscrowState | null;
  balance: bigint | null;
  mint: string;
  recipient: string;
  amountBase: bigint;
  nowUnix: bigint;
}): LaunchCheck[] {
  const { label, escrow } = args;
  const c = (check: string, ok: boolean, detail: string): LaunchCheck => ({
    check: `${label}_${check}`,
    ok,
    detail,
  });
  if (!escrow) {
    return [c('lock_found', false, 'escrow=missing')];
  }
  const schedule = vestingScheduleFor(args.label, args.amountBase);
  const lockedTotal = escrow.cliffUnlockAmount + escrow.amountPerPeriod * escrow.numberOfPeriod;
  const minCliff =
    args.nowUnix + BigInt(schedule.cliffMonths) * MONTH_SECONDS - CLIFF_GRACE_SECONDS;
  const linearSeconds = escrow.frequency * escrow.numberOfPeriod;
  const minLinear = BigInt(schedule.linearMonths) * MONTH_SECONDS;
  return [
    c('lock_found', true, 'ok'),
    c('lock_mint', escrow.tokenMint === args.mint, `mint=${escrow.tokenMint}`),
    c(
      'lock_recipient',
      escrow.recipient === args.recipient,
      `recipient=${escrow.recipient} expected=${args.recipient}`,
    ),
    c(
      'lock_immutable',
      escrow.cancelMode === LOCK_MODE_NEITHER && escrow.updateRecipientMode === LOCK_MODE_NEITHER,
      `cancelMode=${escrow.cancelMode} updateRecipientMode=${escrow.updateRecipientMode}`,
    ),
    c(
      'lock_token_program',
      escrow.tokenProgramFlag === LOCK_TOKEN_PROGRAM_2022,
      `tokenProgramFlag=${escrow.tokenProgramFlag}`,
    ),
    c(
      'lock_untouched',
      escrow.cancelledAt === 0n && escrow.totalClaimedAmount === 0n,
      `cancelledAt=${escrow.cancelledAt} claimed=${escrow.totalClaimedAmount}`,
    ),
    c(
      'lock_amount',
      lockedTotal === args.amountBase,
      `locked=${lockedTotal} expected=${args.amountBase}`,
    ),
    c(
      'lock_schedule',
      escrow.cliffTime >= minCliff && linearSeconds >= minLinear,
      `cliff=${escrow.cliffTime} minCliff=${minCliff} linear=${linearSeconds} minLinear=${minLinear}`,
    ),
    c(
      'lock_funded',
      args.balance !== null && args.balance >= args.amountBase,
      `balance=${args.balance ?? 'unreadable'} expected=${args.amountBase}`,
    ),
  ];
}

export interface LaunchVerifyResponse {
  verified: boolean;
  checks: LaunchCheck[];
}

// Verify the full fair-launch state on-chain: exact supply, renounced mint
// authority, and the three immutable lock escrows. Every check is reported so
// the panel can show the lock-proof checklist; ALL must pass to stamp
// locks_verified_at, and nothing here trusts a founder claim over the chain.
export async function verifyLaunch(
  deps: MintDeps,
  args: {
    accountId: number;
    realmId: number;
    founderLock?: string;
    levyLock?: string;
    treasuryLock?: string;
  },
): Promise<Result<LaunchVerifyResponse>> {
  const roles = await deps.rolesForAccountOnRealm(args.realmId, args.accountId);
  if (!roles.includes('owner')) return fail(403, 'not_realm_owner');
  const token = await deps.tokens.getRealmToken(args.realmId);
  if (!token) return fail(404, 'token_not_registered');
  if (token.mint === null) return fail(409, 'mint_not_created');
  const launch = await deps.launches.getLaunch(args.realmId);
  if (!launch || launch.mintConfirmedAt === null) return fail(409, 'mint_not_created');

  let locks: { founder: string; levy: string; treasury: string };
  if (launch.locksVerifiedAt !== null) {
    // Locks are pinned once verified; re-verification reads the stored
    // addresses (the chain state they point at is immutable by construction).
    locks = {
      founder: launch.founderLockAddress ?? '',
      levy: launch.levyLockAddress ?? '',
      treasury: launch.treasuryLockAddress ?? '',
    };
  } else {
    const founderLock = (args.founderLock ?? '').trim();
    const levyLock = (args.levyLock ?? '').trim();
    const treasuryLock = (args.treasuryLock ?? '').trim();
    const all = [founderLock, levyLock, treasuryLock];
    if (!all.every(isSolanaAddress) || new Set(all).size !== 3) {
      return fail(400, 'invalid_lock_address');
    }
    locks = { founder: founderLock, levy: levyLock, treasury: treasuryLock };
    if (!(await deps.launches.setLockAddresses(args.realmId, locks))) {
      return fail(409, 'launch_not_verifiable');
    }
  }

  const checks: LaunchCheck[] = [];
  const state = await deps.chain.fetchMintState(token.mint);
  if (!state) {
    checks.push({ check: 'mint_found', ok: false, detail: 'mint=unreadable' });
    return { ok: true, verified: false, checks };
  }
  checks.push({ check: 'mint_found', ok: true, detail: `mint=${token.mint}` });
  const profile = mintProfileIssues(state, { mint: token.mint, symbol: token.symbol });
  checks.push({
    check: 'mint_profile',
    ok: profile.length === 0,
    detail: profile.length === 0 ? 'ok' : profile.join(','),
  });
  checks.push({
    check: 'supply_exact',
    ok: state.supply === launch.supplyBase,
    detail: `supply=${state.supply} expected=${launch.supplyBase}`,
  });
  checks.push({
    check: 'mint_authority_renounced',
    ok: state.mintAuthority === null,
    detail: state.mintAuthority === null ? 'ok' : `authority=${state.mintAuthority}`,
  });

  const split = splitSupplyBase(launch.supplyBase, launch.alloc);
  const nowUnix = BigInt(Math.floor(Date.now() / 1000));
  const buckets: Array<{ label: LockedBucket; addr: string; recipient: string; amount: bigint }> = [
    {
      label: 'founder',
      addr: locks.founder,
      recipient: launch.founderWallet,
      amount: split.founderBase,
    },
    { label: 'levy', addr: locks.levy, recipient: launch.levyWallet, amount: split.levyBase },
    {
      label: 'treasury',
      addr: locks.treasury,
      recipient: launch.treasuryWallet,
      amount: split.treasuryBase,
    },
  ];
  for (const b of buckets) {
    const escrow = await deps.chain.fetchVestingEscrow(b.addr);
    const balance = escrow ? await deps.chain.fetchOwnedBalance(token.mint, b.addr) : null;
    checks.push(
      ...escrowChecks({
        label: b.label,
        escrow,
        balance,
        mint: token.mint,
        recipient: b.recipient,
        amountBase: b.amount,
        nowUnix,
      }),
    );
  }

  const verified = checks.every((c) => c.ok);
  if (verified && launch.locksVerifiedAt === null) {
    await deps.launches.markLocksVerified(args.realmId);
  }
  return { ok: true, verified, checks };
}

// ── Listing gate ─────────────────────────────────────────────────────────────

// A token may reach `live` ONLY with a confirmed mint, verified immutable
// locks, and a curve to trade on (phase 4 sets curve_address then calls
// listRealmToken). Pure so the gate itself is unit-tested.
export function launchReadyToList(launch: RealmTokenLaunch | null, token: RealmToken): boolean {
  return (
    launch !== null &&
    token.mint !== null &&
    launch.mintConfirmedAt !== null &&
    launch.locksVerifiedAt !== null &&
    token.curveAddress !== null
  );
}

export async function listRealmToken(
  deps: Pick<MintDeps, 'tokens' | 'launches'>,
  realmId: number,
): Promise<Result<{ status: RealmToken['status'] }>> {
  const token = await deps.tokens.getRealmToken(realmId);
  if (!token) return fail(404, 'token_not_registered');
  const launch = await deps.launches.getLaunch(realmId);
  if (!launchReadyToList(launch, token)) return fail(409, 'locks_not_verified');
  const flipped = await deps.tokens.setRealmTokenStatus(realmId, ['funded'], 'live');
  if (!flipped) return fail(409, 'not_listable');
  return { ok: true, status: flipped.status };
}

// ── Launch status (panel read; no RPC) ───────────────────────────────────────

export interface LaunchStatusResponse {
  prepared: boolean;
  mint: string | null;
  pendingMint: string | null;
  supplyBase: string | null;
  alloc: AllocationBps | null;
  split: Record<keyof SupplySplit, string> | null;
  lockTerms: BucketTerms[] | null;
  lockAddresses: { founder: string | null; levy: string | null; treasury: string | null } | null;
  mintConfirmed: boolean;
  locksVerified: boolean;
}

export async function launchStatus(
  deps: Pick<MintDeps, 'tokens' | 'launches'>,
  realmId: number,
): Promise<Result<{ launch: LaunchStatusResponse }>> {
  const token = await deps.tokens.getRealmToken(realmId);
  if (!token) return fail(404, 'token_not_registered');
  const launch = await deps.launches.getLaunch(realmId);
  if (!launch) {
    return {
      ok: true,
      launch: {
        prepared: false,
        mint: token.mint,
        pendingMint: null,
        supplyBase: null,
        alloc: null,
        split: null,
        lockTerms: null,
        lockAddresses: null,
        mintConfirmed: false,
        locksVerified: false,
      },
    };
  }
  const split = splitSupplyBase(launch.supplyBase, launch.alloc);
  return {
    ok: true,
    launch: {
      prepared: true,
      mint: token.mint,
      pendingMint: launch.pendingMint,
      supplyBase: launch.supplyBase.toString(),
      alloc: launch.alloc,
      split: {
        publicBase: split.publicBase.toString(),
        liquidityBase: split.liquidityBase.toString(),
        founderBase: split.founderBase.toString(),
        levyBase: split.levyBase.toString(),
        treasuryBase: split.treasuryBase.toString(),
      },
      lockTerms: lockTermsFor(launch),
      lockAddresses: {
        founder: launch.founderLockAddress,
        levy: launch.levyLockAddress,
        treasury: launch.treasuryLockAddress,
      },
      mintConfirmed: launch.mintConfirmedAt !== null,
      locksVerified: launch.locksVerifiedAt !== null,
    },
  };
}
