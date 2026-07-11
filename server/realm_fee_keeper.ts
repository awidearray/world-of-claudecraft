// Realm-token fee keeper (launchpad phase 5, PRD section 5.6): claims the DBC
// partner trading fees each live realm-token pool accrues and distributes them
// through the per-realm revenue split: operator / global treasury / affiliate
// (carved out of the operator share, per the #477 rail) / $WOC buy-and-burn.
//
// The buy-and-burn leg lands in the EXISTING realm buyback vault, where the
// #475 realm-buyback keeper (source-scoped) swaps it to $WOC and burns it: the
// terminal step is already pluggable, so this keeper never swaps anything.
//
// Discipline mirrors the proven PayoutKeeper: durable intent BEFORE broadcast
// (a claim row with UNIQUE(claim_tx_sig) is written before the claim is sent;
// the split legs are pinned on the row before distribution), recovery strictly
// by recorded signature, and a cross-process Postgres advisory lock
// (withRealmFeeKeeperLock) so sibling realm processes never double-claim.
// Fail-closed everywhere: no operator wallet -> the pool is skipped and fees
// stay claimable on-chain; missing config -> the keeper never constructs.
//
// No SQL here (realm_fee_db.ts owns the claim ledger); no SDK here (the live
// gateway in realm_launchpad_dbc.ts is the only Meteora import).

// ── Pure split math ──────────────────────────────────────────────────────────

export interface FeeSplitBps {
  treasuryBps: number;
  buybackBps: number;
}

export const FEE_TREASURY_BPS_CAP = 5000;
export const FEE_BUYBACK_BPS_CAP = 5000;
// The operator's floor: treasury + buyback can never exceed 8000 bps, so the
// realm operator always keeps at least 20 percent of the fee stream.
export const FEE_OPERATOR_FLOOR_BPS = 2000;

function bpsEnv(raw: string | undefined, def: number, cap: number): number {
  if (raw === undefined || !/^[0-9]{1,5}$/.test(raw.trim())) return def;
  const n = Number.parseInt(raw, 10);
  return n <= cap ? n : def;
}

export function feeSplitBps(env: Record<string, string | undefined> = process.env): FeeSplitBps {
  let treasuryBps = bpsEnv(env.REALM_FEE_TREASURY_BPS, 2000, FEE_TREASURY_BPS_CAP);
  let buybackBps = bpsEnv(env.REALM_FEE_BUYBACK_BPS, 3000, FEE_BUYBACK_BPS_CAP);
  if (treasuryBps + buybackBps > 10_000 - FEE_OPERATOR_FLOOR_BPS) {
    treasuryBps = 2000;
    buybackBps = 3000;
  }
  return { treasuryBps, buybackBps };
}

export interface FeeSplit {
  operatorBase: bigint;
  affiliateBase: bigint;
  treasuryBase: bigint;
  buybackBase: bigint;
}

// Exact bigint split: treasury and buyback floor their shares, the affiliate
// cut is carved out of the operator's GROSS remainder (PRD: "the affiliate bps
// out of the operator share"), and the operator absorbs every rounding
// remainder, so the four legs always sum to exactly the claimed amount.
export function splitClaimedFees(
  claimedBase: bigint,
  split: FeeSplitBps,
  affiliateBps: number,
): FeeSplit {
  if (claimedBase < 0n) throw new Error('claimed amount must not be negative');
  const treasuryBase = (claimedBase * BigInt(split.treasuryBps)) / 10_000n;
  const buybackBase = (claimedBase * BigInt(split.buybackBps)) / 10_000n;
  const operatorGross = claimedBase - treasuryBase - buybackBase;
  const boundedAffiliateBps = BigInt(Math.min(10_000, Math.max(0, Math.trunc(affiliateBps))));
  const affiliateBase = (operatorGross * boundedAffiliateBps) / 10_000n;
  return {
    operatorBase: operatorGross - affiliateBase,
    affiliateBase,
    treasuryBase,
    buybackBase,
  };
}

// ── Persistence + chain seams ────────────────────────────────────────────────

export type FeeClaimStatus = 'claiming' | 'claimed' | 'distributing' | 'distributed' | 'failed';

export interface FeeClaimRow {
  claimId: string;
  realmId: number;
  poolAddress: string;
  quoteMint: string; // '' = native SOL
  status: FeeClaimStatus;
  claimTxSig: string | null;
  claimedBase: bigint;
  operatorWallet: string | null;
  affiliateWallet: string | null;
  operatorBase: bigint;
  affiliateBase: bigint;
  treasuryBase: bigint;
  buybackBase: bigint;
  distributeTxSig: string | null;
  distributeBroadcastAt: Date | null;
  createdAt: Date;
}

export interface RealmFeeStore {
  // Durable intent BEFORE broadcast; false when the signature is already
  // tracked (recovery owns it).
  createClaim(row: {
    claimId: string;
    realmId: number;
    poolAddress: string;
    quoteMint: string;
    claimTxSig: string;
  }): Promise<boolean>;
  // Pin the measured amount + the exact split legs + destinations on the row.
  markClaimed(
    claimId: string,
    fields: {
      claimedBase: bigint;
      operatorWallet: string;
      affiliateWallet: string | null;
      split: FeeSplit;
    },
  ): Promise<void>;
  markDistributing(claimId: string, distributeTxSig: string): Promise<void>;
  markDistributed(claimId: string): Promise<void>;
  markFailed(claimId: string, reason: string): Promise<void>;
  openClaims(): Promise<FeeClaimRow[]>;
}

export interface SignedTx {
  signature: string;
  send(): Promise<void>;
}

export interface RealmFeeGateway {
  // The pool's claimable partner quote fees (null = unreadable).
  claimableQuoteFees(poolAddress: string): Promise<bigint | null>;
  // Build + sign the partner fee claim (the keeper's ops key is the DBC
  // config's feeClaimer). Null when the tx cannot be built.
  signClaim(args: { poolAddress: string; maxQuoteBase: bigint }): Promise<SignedTx | null>;
  confirm(signature: string): Promise<'confirmed' | 'failed' | 'unknown'>;
  // Measure what the claimer wallet actually received from the finalized
  // claim (net of the tx fee on the native rail: conservative, never over-
  // distributes).
  receivedQuote(claimSig: string, quoteMint: string): Promise<bigint>;
  // Build + sign the one distribution transaction paying every leg.
  signDistribute(args: {
    quoteMint: string;
    legs: Array<{ dest: string; amountBase: bigint }>;
  }): Promise<SignedTx | null>;
}

export interface FeeTarget {
  realmId: number;
  poolAddress: string;
}

export interface RealmFeeDeps {
  gateway: RealmFeeGateway;
  store: RealmFeeStore;
  // Live/graduated realm tokens with a curve (SQL in realm_token_db.ts).
  listFeeTargets(): Promise<FeeTarget[]>;
  // The quote mint of the live partner config ('' = SOL); null = unreadable,
  // skip the cycle rather than guess.
  readQuoteMint(): Promise<string | null>;
  // The realm owner's verified linked wallet; null = fail-closed skip.
  operatorWallet(realmId: number): Promise<string | null>;
  // The realm's attributed affiliate with a verified wallet; null = no cut.
  affiliateFor(realmId: number): Promise<{ wallet: string; bps: number } | null>;
  treasuryWallet: string;
  buybackWallet: string;
  split: FeeSplitBps;
  thresholdBase(quoteMint: string): bigint;
  // Lamports kept back from a native-SOL distribution for the tx fee.
  nativeFeeReserve: bigint;
  now(): number;
  newClaimId(): string;
  staleMs: number;
}

// ── The keeper ───────────────────────────────────────────────────────────────

export class RealmFeeKeeper {
  constructor(private readonly deps: RealmFeeDeps) {}

  // One tick: finish any in-flight claim first (never two claims against one
  // pool), then sweep every fee target above its threshold.
  async runCycle(): Promise<void> {
    const open = await this.deps.store.openClaims();
    if (open.length > 0) {
      await this.recover(open);
      return;
    }
    const quoteMint = await this.deps.readQuoteMint();
    if (quoteMint === null) return;
    for (const target of await this.deps.listFeeTargets()) {
      await this.processTarget(target, quoteMint);
    }
  }

  private async processTarget(target: FeeTarget, quoteMint: string): Promise<void> {
    const claimable = await this.deps.gateway.claimableQuoteFees(target.poolAddress);
    if (claimable === null || claimable < this.deps.thresholdBase(quoteMint)) return;
    // Fail-closed: never claim what cannot be distributed.
    if ((await this.deps.operatorWallet(target.realmId)) === null) return;

    const claim = await this.deps.gateway.signClaim({
      poolAddress: target.poolAddress,
      maxQuoteBase: claimable,
    });
    if (!claim) return;
    const claimId = this.deps.newClaimId();
    const fresh = await this.deps.store.createClaim({
      claimId,
      realmId: target.realmId,
      poolAddress: target.poolAddress,
      quoteMint,
      claimTxSig: claim.signature,
    });
    if (!fresh) return; // this signed claim is already tracked
    await claim.send();
    const conf = await this.deps.gateway.confirm(claim.signature);
    if (conf === 'failed') {
      await this.deps.store.markFailed(claimId, 'claim reverted');
      return;
    }
    if (conf !== 'confirmed') return; // left 'claiming' for recovery
    await this.completeClaimed({
      claimId,
      realmId: target.realmId,
      quoteMint,
      claimTxSig: claim.signature,
    });
  }

  // Claim confirmed: measure what actually arrived, pin the exact split legs
  // on the row (the ledger the distribution executes verbatim, so a later
  // affiliate change can never rewrite a recorded claim), then distribute.
  private async completeClaimed(args: {
    claimId: string;
    realmId: number;
    quoteMint: string;
    claimTxSig: string;
  }): Promise<void> {
    const received = await this.deps.gateway.receivedQuote(args.claimTxSig, args.quoteMint);
    if (received <= 0n) {
      await this.deps.store.markFailed(args.claimId, 'claim confirmed but nothing received');
      return;
    }
    const operatorWallet = await this.deps.operatorWallet(args.realmId);
    if (!operatorWallet) {
      await this.deps.store.markFailed(args.claimId, 'operator wallet unlinked');
      return;
    }
    const reserve = args.quoteMint === '' ? this.deps.nativeFeeReserve : 0n;
    const distributable = received - reserve;
    if (distributable <= 0n) {
      await this.deps.store.markFailed(args.claimId, 'claimed amount under the fee reserve');
      return;
    }
    const affiliate = await this.deps.affiliateFor(args.realmId);
    const split = splitClaimedFees(distributable, this.deps.split, affiliate?.bps ?? 0);
    await this.deps.store.markClaimed(args.claimId, {
      claimedBase: distributable,
      operatorWallet,
      affiliateWallet: affiliate?.wallet ?? null,
      split,
    });
    await this.distribute({
      claimId: args.claimId,
      quoteMint: args.quoteMint,
      operatorWallet,
      affiliateWallet: affiliate?.wallet ?? null,
      split,
    });
  }

  private async distribute(args: {
    claimId: string;
    quoteMint: string;
    operatorWallet: string;
    affiliateWallet: string | null;
    split: FeeSplit;
  }): Promise<void> {
    const legs = [
      { dest: args.operatorWallet, amountBase: args.split.operatorBase },
      ...(args.affiliateWallet
        ? [{ dest: args.affiliateWallet, amountBase: args.split.affiliateBase }]
        : []),
      { dest: this.deps.treasuryWallet, amountBase: args.split.treasuryBase },
      { dest: this.deps.buybackWallet, amountBase: args.split.buybackBase },
    ].filter((leg) => leg.amountBase > 0n);
    if (legs.length === 0) {
      await this.deps.store.markDistributed(args.claimId);
      return;
    }
    const tx = await this.deps.gateway.signDistribute({ quoteMint: args.quoteMint, legs });
    if (!tx) return; // left 'claimed'; the next cycle retries the distribution
    await this.deps.store.markDistributing(args.claimId, tx.signature);
    await tx.send();
    const conf = await this.deps.gateway.confirm(tx.signature);
    if (conf === 'confirmed') await this.deps.store.markDistributed(args.claimId);
    // failed/unknown: recovery re-checks (and, if stale, re-issues) below.
  }

  // Resolve in-flight claims strictly by their recorded signatures.
  async recover(open?: FeeClaimRow[]): Promise<void> {
    const rows = open ?? (await this.deps.store.openClaims());
    for (const row of rows) {
      if (row.status === 'claiming' && row.claimTxSig) {
        const conf = await this.deps.gateway.confirm(row.claimTxSig);
        if (conf === 'confirmed' || (conf === 'unknown' && this.isStale(row))) {
          // Route through the measurement: >0 recovers the claim, 0 fails it
          // (the fees stay accrued on-chain, nothing stranded).
          await this.completeClaimed({
            claimId: row.claimId,
            realmId: row.realmId,
            quoteMint: row.quoteMint,
            claimTxSig: row.claimTxSig,
          });
        } else if (conf === 'failed') {
          await this.deps.store.markFailed(row.claimId, 'claim reverted');
        }
      } else if (row.status === 'claimed') {
        if (row.operatorWallet === null) {
          await this.deps.store.markFailed(row.claimId, 'claimed row missing operator wallet');
          continue;
        }
        await this.distribute({
          claimId: row.claimId,
          quoteMint: row.quoteMint,
          operatorWallet: row.operatorWallet,
          affiliateWallet: row.affiliateWallet,
          split: {
            operatorBase: row.operatorBase,
            affiliateBase: row.affiliateBase,
            treasuryBase: row.treasuryBase,
            buybackBase: row.buybackBase,
          },
        });
      } else if (row.status === 'distributing' && row.distributeTxSig) {
        const conf = await this.deps.gateway.confirm(row.distributeTxSig);
        if (conf === 'confirmed') {
          await this.deps.store.markDistributed(row.claimId);
        } else if (conf === 'failed' || this.isStale(row)) {
          if (row.operatorWallet === null) {
            await this.deps.store.markFailed(
              row.claimId,
              'distributing row missing operator wallet',
            );
            continue;
          }
          await this.distribute({
            claimId: row.claimId,
            quoteMint: row.quoteMint,
            operatorWallet: row.operatorWallet,
            affiliateWallet: row.affiliateWallet,
            split: {
              operatorBase: row.operatorBase,
              affiliateBase: row.affiliateBase,
              treasuryBase: row.treasuryBase,
              buybackBase: row.buybackBase,
            },
          });
        }
      }
    }
  }

  // Staleness from the phase's OWN broadcast (mirrors PayoutKeeper.isStale).
  private isStale(row: FeeClaimRow): boolean {
    const since =
      row.status === 'distributing' && row.distributeBroadcastAt
        ? row.distributeBroadcastAt
        : row.createdAt;
    return this.deps.now() - new Date(since).getTime() > this.deps.staleMs;
  }
}

// ── Config gate ──────────────────────────────────────────────────────────────

// Per-quote-asset claim thresholds (base units): don't burn tx fees claiming
// dust. Native SOL default 0.05 SOL; SPL quote (USDC-style 6dp) default 25.
export function feeThresholdBase(
  quoteMint: string,
  env: Record<string, string | undefined> = process.env,
): bigint {
  const read = (key: string, def: bigint): bigint => {
    const raw = env[key];
    return raw !== undefined && /^[0-9]{1,20}$/.test(raw.trim()) ? BigInt(raw.trim()) : def;
  };
  return quoteMint === ''
    ? read('REALM_FEE_MIN_CLAIM_LAMPORTS', 50_000_000n)
    : read('REALM_FEE_MIN_CLAIM_QUOTE_BASE', 25_000_000n);
}

export function realmFeeKeeperConfigured(
  env: Record<string, string | undefined> = process.env,
): boolean {
  return (
    (env.REALM_FEE_CLAIMER_SECRET ?? '').trim().length > 0 &&
    (env.REALM_FEE_TREASURY_WALLET ?? env.WOC_TREASURY ?? '').trim().length > 0 &&
    (env.REALM_BUYBACK_VAULT ?? '').trim().length > 0
  );
}
