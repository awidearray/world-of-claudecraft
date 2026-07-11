// Per-realm fee revenue keeper (launchpad phase 5). The DBC partner trading
// fees of every curve-launched realm token flow into the per-realm revenue
// split (PRD section 7.8) through three stages:
//
//   CLAIM (ops)     The pool's partner fees are claimable only by the config's
//                   fee-claimer PDA (an ops multisig, never an EOA, phase 4).
//                   Ops executes the claim with the KEEPER VAULT as receiver;
//                   `listClaimableFees` reports what is claimable per realm,
//                   read live off the chain.
//   ACCRUE (verify) `registerFeeClaim` verifies the FINALIZED claim credited
//                   the vault and records a `realm_fee_accruals` row
//                   (UNIQUE(claim_tx_sig)), so per-realm attribution is exact
//                   even though the vault is shared across realms.
//   DRAIN (keeper)  `runFeeCycle` walks every curve-launched realm and, under
//                   the per-realm Postgres advisory TRY-lock (no-double-spend),
//                   cuts the accrued-minus-distributed balance into the four
//                   legs (operator minus the affiliate cut, affiliate, global
//                   treasury, burn), ledger-first: the distribution row and
//                   every leg signature are durable BEFORE each broadcast, so
//                   recovery resolves by recorded signature and a crash can
//                   never double-pay. The burn leg is the pluggable terminal:
//                   it transfers to the realm-buyback vault (whose existing
//                   PayoutKeeper swaps to $WOC and burns) or to a configured
//                   LP-seed destination.
//
// The keeper key (REALM_FEE_VAULT_SECRET) is ops-owned and lives only in the
// production wiring below, mirroring payout_keeper.ts: the orchestration runs
// over injected interfaces and is unit-tested with fakes.

import { randomUUID } from 'node:crypto';
import { Connection, Keypair, PublicKey, SystemProgram, Transaction } from '@solana/web3.js';
import bs58 from 'bs58';
import { associatedTokenAccount, transferCheckedIx } from './payout_keeper';
import { realmFeeSplitBps, splitRealmFees } from './realm_fee_split';
import type { LaunchVenue } from './realm_launchpad';
import { fail, type Result } from './realm_token';
import {
  fetchFinalizedTransaction,
  parseNativePayment,
  parseSplitPayment,
  SOLANA_RPC_URL,
  signatureStatus,
  solanaRpc,
} from './solana_rpc';
import { isSolanaAddress } from './wallet_link';
import { USDC_MINT } from './woc_config';

const BASE58_SIG = /^[1-9A-HJ-NP-Za-km-z]{32,90}$/;

export type FeeVaultCurrency = 'SOL' | 'USDC';
export type FeeDistributionLeg = 'operator' | 'treasury' | 'affiliate' | 'burn';
export const FEE_LEGS: readonly FeeDistributionLeg[] = [
  'operator',
  'treasury',
  'affiliate',
  'burn',
];

export interface FeeDistributionRow {
  distributionId: number;
  realmId: number;
  currency: FeeVaultCurrency;
  totalBase: bigint;
  operatorBase: bigint;
  treasuryBase: bigint;
  affiliateBase: bigint;
  burnBase: bigint;
  operatorWallet: string;
  treasuryWallet: string;
  affiliateWallet: string | null;
  burnDest: string;
  status: 'paying' | 'paid' | 'failed';
  legSigs: Record<FeeDistributionLeg, string | null>;
  legPaid: Record<FeeDistributionLeg, boolean>;
  reason?: string;
  lastBroadcastAt: Date | null;
  createdAt: Date;
}

// The SQL surface realm_fee_db.ts implements; tests fake it in memory.
export interface RealmFeeStore {
  insertAccrual(a: {
    realmId: number;
    currency: FeeVaultCurrency;
    amountBase: bigint;
    claimTxSig: string;
  }): Promise<boolean>;
  unspentAccruedBase(realmId: number, currency: FeeVaultCurrency): Promise<bigint>;
  createDistribution(d: {
    realmId: number;
    currency: FeeVaultCurrency;
    totalBase: bigint;
    operatorBase: bigint;
    treasuryBase: bigint;
    affiliateBase: bigint;
    burnBase: bigint;
    operatorWallet: string;
    treasuryWallet: string;
    affiliateWallet: string | null;
    burnDest: string;
  }): Promise<number>;
  openDistribution(realmId: number, currency: FeeVaultCurrency): Promise<FeeDistributionRow | null>;
  recordLegSig(distributionId: number, leg: FeeDistributionLeg, sig: string): Promise<void>;
  markLegPaid(distributionId: number, leg: FeeDistributionLeg): Promise<void>;
  markPaid(distributionId: number): Promise<void>;
  markFailed(distributionId: number, reason: string): Promise<void>;
  listFeeRealms(): Promise<
    Array<{ realmId: number; poolAddress: string; feeClaimerPda: string | null }>
  >;
  // The advisory TRY-lock: runs fn while holding the per-realm lock, or
  // returns null without running it when another holder owns the realm.
  withRealmFeeLock<T>(realmId: number, fn: () => Promise<T>): Promise<T | null>;
}

// Signing + on-chain transfer I/O, injected so the orchestration tests run on
// fakes and only the production wiring below holds the vault key.
export interface FeeExecutor {
  vaultAddress(): string;
  signTransfer(
    dest: string,
    amountBase: bigint,
    currency: FeeVaultCurrency,
  ): Promise<{ signature: string; send(): Promise<void> }>;
  confirm(signature: string): Promise<'confirmed' | 'failed' | 'unknown'>;
}

export interface FeeKeeperDeps {
  store: RealmFeeStore;
  exec: FeeExecutor;
  venue: LaunchVenue | null;
  // The realm owner's linked wallet (the operator leg destination).
  operatorWalletForRealm(realmId: number): Promise<string | null>;
  // The realm's affiliate cut, if any (paid out of the operator side).
  affiliateForRealm(realmId: number): Promise<{ wallet: string; bps: number } | null>;
  now(): number;
}

function intEnv(key: string, def: number, min: number, max: number): number {
  const v = Number.parseInt(process.env[key] ?? '', 10);
  return Number.isFinite(v) && v >= min && v <= max ? v : def;
}

// The platform's global-treasury wallet: fail closed, the keeper does nothing
// without it.
export function feeTreasuryWallet(): string | null {
  const raw = (process.env.REALM_FEE_TREASURY_WALLET ?? '').trim();
  return raw && isSolanaAddress(raw) ? raw : null;
}

// The pluggable burn terminal: the realm-buyback vault by default (its
// existing keeper swaps to $WOC and burns), or an LP-seed destination.
export function feeBurnDest(): string | null {
  const explicit = (process.env.REALM_FEE_BURN_DEST ?? '').trim();
  if (explicit && isSolanaAddress(explicit)) return explicit;
  const buyback = (process.env.REALM_BUYBACK_VAULT ?? '').trim();
  return buyback && isSolanaAddress(buyback) ? buyback : null;
}

// Minimum accrued balance worth draining (base units of the currency).
function drainFloorBase(currency: FeeVaultCurrency): bigint {
  const key = currency === 'SOL' ? 'REALM_FEE_MIN_DRAIN_SOL_BASE' : 'REALM_FEE_MIN_DRAIN_USDC_BASE';
  const def = currency === 'SOL' ? 10_000_000 : 1_000_000; // 0.01 SOL / 1 USDC
  return BigInt(intEnv(key, def, 1, 1_000_000_000_000));
}

// A broadcast this old that still will not confirm can no longer land (its
// blockhash is long expired), so the leg is safely re-signed.
const LEG_STALE_MS = 10 * 60 * 1000;

// ── Accrual: verify a finalized ops claim into the vault ─────────────────────

export async function registerFeeClaim(
  deps: Pick<FeeKeeperDeps, 'store' | 'exec'>,
  args: { realmId: number; currency: string; signature: string },
): Promise<Result<{ amountBase: string }>> {
  if (args.currency !== 'SOL' && args.currency !== 'USDC') return fail(400, 'invalid_currency');
  if (!BASE58_SIG.test(args.signature)) return fail(400, 'bad_signature');
  const realms = await deps.store.listFeeRealms();
  if (!realms.some((r) => r.realmId === args.realmId)) return fail(404, 'curve_not_launched');

  const tx = await fetchFinalizedTransaction(args.signature);
  if (!tx) return fail(409, 'not_finalized');
  const vault = deps.exec.vaultAddress();
  let credited: bigint;
  if (args.currency === 'SOL') {
    const p = parseNativePayment(tx);
    if (!p.succeeded) return fail(400, 'tx_failed');
    credited = p.lamportDeltas.get(vault) ?? 0n;
  } else {
    const p = parseSplitPayment(tx, USDC_MINT);
    if (!p.succeeded) return fail(400, 'tx_failed');
    credited = p.tokenDeltas.get(vault) ?? 0n;
  }
  if (credited <= 0n) return fail(400, 'claim_not_credited');

  const fresh = await deps.store.insertAccrual({
    realmId: args.realmId,
    currency: args.currency,
    amountBase: credited,
    claimTxSig: args.signature,
  });
  if (!fresh) return fail(409, 'launch_sig_reused');
  return { ok: true, amountBase: credited.toString() };
}

// ── Claim assist: what ops needs to run the PDA-signed claim ─────────────────

export interface ClaimAssist {
  realmId: number;
  poolAddress: string;
  feeClaimer: string | null;
  receiver: string;
  claimableQuoteBase: string;
}

// Live claimable partner fees per curve realm, straight off the chain, plus
// the receiver (the keeper vault) the ops claim should credit.
export async function listClaimableFees(
  deps: Pick<FeeKeeperDeps, 'store' | 'exec' | 'venue'>,
): Promise<ClaimAssist[]> {
  if (deps.venue === null) return [];
  const out: ClaimAssist[] = [];
  for (const realm of await deps.store.listFeeRealms()) {
    const state = await deps.venue.poolState(realm.poolAddress);
    if (!state) continue;
    out.push({
      realmId: realm.realmId,
      poolAddress: realm.poolAddress,
      feeClaimer: realm.feeClaimerPda,
      receiver: deps.exec.vaultAddress(),
      claimableQuoteBase: state.partnerQuoteFeeBase.toString(),
    });
  }
  return out;
}

// ── Drain: the split, ledger-first, advisory-locked ──────────────────────────

export interface FeeCycleReport {
  realmId: number;
  currency: FeeVaultCurrency;
  action: 'skipped_locked' | 'skipped_below_floor' | 'skipped_unpayable' | 'recovered' | 'paid';
  totalBase?: string;
}

// One leg: sign (recording the signature FIRST), broadcast, confirm. Returns
// whether the leg is now durably paid.
async function payLeg(
  deps: FeeKeeperDeps,
  row: FeeDistributionRow,
  leg: FeeDistributionLeg,
  dest: string,
  amountBase: bigint,
): Promise<boolean> {
  if (amountBase <= 0n) {
    await deps.store.markLegPaid(row.distributionId, leg);
    return true;
  }
  const recorded = row.legSigs[leg];
  if (recorded !== null) {
    const conf = await deps.exec.confirm(recorded);
    if (conf === 'confirmed') {
      await deps.store.markLegPaid(row.distributionId, leg);
      return true;
    }
    if (conf === 'unknown') {
      // Still possibly in flight: only a long-stale broadcast (blockhash
      // expired, can never land) is safely re-signed.
      const since = row.lastBroadcastAt ? row.lastBroadcastAt.getTime() : 0;
      if (deps.now() - since < LEG_STALE_MS) return false;
    }
    // failed, or stale-unknown: fall through and re-issue.
  }
  const tx = await deps.exec.signTransfer(dest, amountBase, row.currency);
  await deps.store.recordLegSig(row.distributionId, leg, tx.signature);
  await tx.send();
  const conf = await deps.exec.confirm(tx.signature);
  if (conf !== 'confirmed') return false;
  await deps.store.markLegPaid(row.distributionId, leg);
  return true;
}

// Drive one open distribution to completion (or as far as confirmations
// allow). Legs run in a fixed order; a leg that will not confirm leaves the
// rest for the next cycle.
async function driveDistribution(deps: FeeKeeperDeps, row: FeeDistributionRow): Promise<boolean> {
  const plan: Array<[FeeDistributionLeg, string | null, bigint]> = [
    ['operator', row.operatorWallet, row.operatorBase],
    ['treasury', row.treasuryWallet, row.treasuryBase],
    ['affiliate', row.affiliateWallet, row.affiliateBase],
    ['burn', row.burnDest, row.burnBase],
  ];
  for (const [leg, dest, amount] of plan) {
    if (row.legPaid[leg]) continue;
    if (amount > 0n && dest === null) {
      await deps.store.markFailed(row.distributionId, `${leg} destination missing`);
      return false;
    }
    const paid = await payLeg(deps, row, leg, dest ?? '', amount);
    if (!paid) return false;
  }
  await deps.store.markPaid(row.distributionId);
  return true;
}

// One keeper tick over every curve-launched realm and both currencies. Each
// (realm, currency) drain runs under the per-realm advisory TRY-lock; a
// contended realm is skipped, never waited on.
export async function runFeeCycle(deps: FeeKeeperDeps): Promise<FeeCycleReport[]> {
  const treasury = feeTreasuryWallet();
  const burnDest = feeBurnDest();
  if (treasury === null || burnDest === null) return [];
  const reports: FeeCycleReport[] = [];
  for (const realm of await deps.store.listFeeRealms()) {
    for (const currency of ['SOL', 'USDC'] as const) {
      const report = await deps.store.withRealmFeeLock(realm.realmId, async () => {
        // Recovery first: an open distribution owns the realm until done.
        const open = await deps.store.openDistribution(realm.realmId, currency);
        if (open) {
          await driveDistribution(deps, open);
          return {
            realmId: realm.realmId,
            currency,
            action: 'recovered',
            totalBase: open.totalBase.toString(),
          } satisfies FeeCycleReport;
        }
        const unspent = await deps.store.unspentAccruedBase(realm.realmId, currency);
        if (unspent < drainFloorBase(currency)) {
          return {
            realmId: realm.realmId,
            currency,
            action: 'skipped_below_floor',
          } satisfies FeeCycleReport;
        }
        const operatorWallet = await deps.operatorWalletForRealm(realm.realmId);
        if (operatorWallet === null) {
          // The accrual stays; the operator links a wallet and the next cycle pays.
          return {
            realmId: realm.realmId,
            currency,
            action: 'skipped_unpayable',
          } satisfies FeeCycleReport;
        }
        const affiliate = await deps.affiliateForRealm(realm.realmId);
        const split = splitRealmFees(unspent, realmFeeSplitBps(), affiliate?.bps ?? 0);
        const distributionId = await deps.store.createDistribution({
          realmId: realm.realmId,
          currency,
          totalBase: split.totalBase,
          operatorBase: split.operatorBase,
          treasuryBase: split.treasuryBase,
          affiliateBase: split.affiliateBase,
          burnBase: split.burnBase,
          operatorWallet,
          treasuryWallet: treasury,
          affiliateWallet: affiliate?.wallet ?? null,
          burnDest,
        });
        const row = await deps.store.openDistribution(realm.realmId, currency);
        if (row && row.distributionId === distributionId) await driveDistribution(deps, row);
        return {
          realmId: realm.realmId,
          currency,
          action: 'paid',
          totalBase: split.totalBase.toString(),
        } satisfies FeeCycleReport;
      });
      reports.push(report ?? { realmId: realm.realmId, currency, action: 'skipped_locked' });
    }
  }
  return reports;
}

// ── Production wiring (the ONLY key-holding code on this path) ────────────────

const FEE_VAULT = (process.env.REALM_FEE_VAULT ?? '').trim();
const FEE_VAULT_SECRET = (process.env.REALM_FEE_VAULT_SECRET ?? '').trim();

export function feeKeeperConfigured(): boolean {
  return (
    isSolanaAddress(FEE_VAULT) &&
    FEE_VAULT_SECRET.length > 0 &&
    feeTreasuryWallet() !== null &&
    feeBurnDest() !== null
  );
}

export function buildFeeExecutor(): FeeExecutor {
  const vault = Keypair.fromSecretKey(bs58.decode(FEE_VAULT_SECRET));
  if (vault.publicKey.toBase58() !== FEE_VAULT) {
    throw new Error('REALM_FEE_VAULT_SECRET does not match REALM_FEE_VAULT');
  }
  const conn = new Connection(SOLANA_RPC_URL, 'confirmed');
  const usdcMint = new PublicKey(USDC_MINT);
  return {
    vaultAddress: () => FEE_VAULT,
    async signTransfer(dest, amountBase, currency) {
      const { blockhash, lastValidBlockHeight } = await conn.getLatestBlockhash();
      const tx = new Transaction({ feePayer: vault.publicKey, blockhash, lastValidBlockHeight });
      if (currency === 'SOL') {
        tx.add(
          SystemProgram.transfer({
            fromPubkey: vault.publicKey,
            toPubkey: new PublicKey(dest),
            lamports: amountBase,
          }),
        );
      } else {
        const decimalsRes = await solanaRpc<{ value?: { decimals?: number } }>('getTokenSupply', [
          USDC_MINT,
        ]);
        const decimals = decimalsRes?.value?.decimals;
        if (typeof decimals !== 'number') throw new Error('could not read USDC decimals');
        tx.add(
          transferCheckedIx(
            associatedTokenAccount(vault.publicKey, usdcMint),
            usdcMint,
            associatedTokenAccount(new PublicKey(dest), usdcMint),
            vault.publicKey,
            amountBase,
            decimals,
          ),
        );
      }
      tx.sign(vault);
      const signature = bs58.encode(tx.signature as Buffer);
      return {
        signature,
        send: async () => {
          await conn.sendRawTransaction(tx.serialize(), { skipPreflight: false, maxRetries: 5 });
        },
      };
    },
    confirm: signatureStatus,
  };
}
