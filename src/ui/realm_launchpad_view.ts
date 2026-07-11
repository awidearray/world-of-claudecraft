// Pure view-core for the realm token launchpad panel (phases 0 to 2): maps the
// server's token / vote / presale payloads to a render model of stable
// discriminators and pre-formatted numeric strings. DOM-free, i18n-free
// (the painter maps discriminators to launchpad.* t() keys), Node-tested, and
// registered in UI_PURE_CORES (tests/architecture.test.ts).

export type LaunchpadStatus =
  | 'prelaunch'
  | 'voting'
  | 'presale'
  | 'funded'
  | 'refunding'
  | 'refunded'
  | 'live'
  | 'graduated'
  | 'closed';

export interface VoteWire {
  status: LaunchpadStatus;
  yesWeight: string; // whole $WOC decimal strings
  noWeight: string;
  voteCount: number;
  quorumWoc: string;
  yesThresholdBps: number;
  outcome: 'pending' | 'passed' | 'failed';
  myChoice: 'yes' | 'no' | null;
  myWeightWoc: string | null;
}

export interface VoteViewModel {
  yesWeight: bigint;
  noWeight: bigint;
  totalWeight: bigint;
  quorum: bigint;
  // 0..100 integer percentages for the two progress bars.
  yesSharePct: number;
  quorumPct: number;
  thresholdPct: number; // the yes threshold as a whole percent (display)
  outcome: 'pending' | 'passed' | 'failed';
  canVote: boolean; // the window is open and the caller has not voted yet
  myChoice: 'yes' | 'no' | null;
  myWeight: bigint | null;
}

export function voteView(v: VoteWire): VoteViewModel {
  const yesWeight = BigInt(v.yesWeight);
  const noWeight = BigInt(v.noWeight);
  const totalWeight = yesWeight + noWeight;
  const quorum = BigInt(v.quorumWoc);
  const yesSharePct = totalWeight > 0n ? Number((yesWeight * 100n) / totalWeight) : 0;
  const quorumRaw = quorum > 0n ? Number((totalWeight * 100n) / quorum) : 100;
  return {
    yesWeight,
    noWeight,
    totalWeight,
    quorum,
    yesSharePct,
    quorumPct: Math.min(100, quorumRaw),
    thresholdPct: Math.round(v.yesThresholdBps / 100),
    outcome: v.outcome,
    canVote: v.status === 'voting' && v.myChoice === null,
    myChoice: v.myChoice,
    myWeight: v.myWeightWoc === null ? null : BigInt(v.myWeightWoc),
  };
}

export interface PresaleRailWire {
  currency: 'SOL' | 'USDC' | 'WOC';
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

export interface PresaleWire {
  configured: boolean;
  status: LaunchpadStatus;
  escrowWallet: string | null;
  progressBps: number;
  softCapMet: boolean;
  rails: PresaleRailWire[];
  refund: { unrefundedCount: number } | null;
}

export interface PresaleRailViewModel {
  currency: 'SOL' | 'USDC' | 'WOC';
  decimals: number;
  raisedBase: bigint;
  softCapBase: bigint;
  raiseCapBase: bigint;
  myRemainingBase: bigint;
  railPct: number; // 0..100 of this rail's soft component
  contributable: boolean; // open presale and headroom left for this wallet
}

export interface PresaleViewModel {
  configured: boolean;
  open: boolean; // status === 'presale' (contributions accepted)
  progressPct: number; // 0..100 of the combined soft cap
  softCapMet: boolean;
  escrowWallet: string | null;
  rails: PresaleRailViewModel[];
  refunding: boolean;
  unrefundedCount: number;
}

export function presaleView(p: PresaleWire): PresaleViewModel {
  const open = p.status === 'presale';
  return {
    configured: p.configured,
    open,
    progressPct: Math.min(100, Math.floor(p.progressBps / 100)),
    softCapMet: p.softCapMet,
    escrowWallet: p.escrowWallet,
    rails: p.rails.map((r) => {
      const raised = BigInt(r.raisedBase);
      const soft = BigInt(r.softCapBase);
      const remaining = BigInt(r.myRemainingBase);
      const pctRaw = soft > 0n ? Number((raised * 100n) / soft) : 0;
      return {
        currency: r.currency,
        decimals: r.decimals,
        raisedBase: raised,
        softCapBase: soft,
        raiseCapBase: BigInt(r.raiseCapBase),
        myRemainingBase: remaining,
        railPct: Math.min(100, pctRaw),
        contributable: open && remaining > 0n,
      };
    }),
    refunding: p.status === 'refunding' || p.status === 'refunded',
    unrefundedCount: p.refund?.unrefundedCount ?? 0,
  };
}

// The founder's launch checklist: which step each lifecycle status sits on.
export type ChecklistStep = 'register' | 'vote' | 'presale' | 'launch';
export interface ChecklistItem {
  step: ChecklistStep;
  done: boolean;
  current: boolean;
}

export function launchpadChecklist(status: LaunchpadStatus | 'none'): ChecklistItem[] {
  const order: ChecklistStep[] = ['register', 'vote', 'presale', 'launch'];
  const stepIndex: Record<LaunchpadStatus | 'none', number> = {
    none: 0,
    prelaunch: 1,
    voting: 1,
    presale: 2,
    funded: 3,
    refunding: 2,
    refunded: 2,
    live: 4,
    graduated: 4,
    closed: 4,
  };
  const at = stepIndex[status];
  return order.map((step, i) => ({ step, done: i < at, current: i === at }));
}

// ── Launch pipeline (phase 3) view ───────────────────────────────────────────

export interface LaunchBucketTermsWire {
  bucket: 'founder' | 'levy' | 'treasury';
  recipient: string;
  amountBase: string;
  cliffMonths: number;
  linearMonths: number;
  frequencySeconds: string;
  cliffUnlockAmount: string;
  amountPerPeriod: string;
  numberOfPeriod: string;
}

export interface LaunchWire {
  prepared: boolean;
  mint: string | null;
  pendingMint: string | null;
  supplyBase: string | null;
  alloc: {
    publicBps: number;
    liquidityBps: number;
    founderBps: number;
    levyBps: number;
    treasuryBps: number;
  } | null;
  split: {
    publicBase: string;
    liquidityBase: string;
    founderBase: string;
    levyBase: string;
    treasuryBase: string;
  } | null;
  lockTerms: LaunchBucketTermsWire[] | null;
  lockAddresses: { founder: string | null; levy: string | null; treasury: string | null } | null;
  mintConfirmed: boolean;
  locksVerified: boolean;
}

// The launch pipeline's own step ladder: create the mint, distribute + lock,
// verify on-chain, list. Discriminators only; the painter maps them to keys.
export type LaunchStep = 'mint' | 'locks' | 'verify' | 'list';

export interface LaunchBucketViewModel {
  bucket: 'founder' | 'levy' | 'treasury';
  recipient: string;
  amountBase: bigint;
  shareBps: number;
  cliffMonths: number;
  linearMonths: number;
  lockAddress: string | null;
}

export interface LaunchViewModel {
  prepared: boolean;
  mint: string | null;
  supplyBase: bigint | null;
  publicBps: number;
  liquidityBps: number;
  buckets: LaunchBucketViewModel[];
  steps: Array<{ step: LaunchStep; done: boolean; current: boolean }>;
  mintConfirmed: boolean;
  locksVerified: boolean;
  // The founder still has lock addresses to submit (mint done, locks not yet
  // verified): the verify form should render.
  needsLockAddresses: boolean;
}

export function launchView(l: LaunchWire, status: LaunchpadStatus): LaunchViewModel {
  const bpsByBucket: Record<'founder' | 'levy' | 'treasury', number> = {
    founder: l.alloc?.founderBps ?? 0,
    levy: l.alloc?.levyBps ?? 0,
    treasury: l.alloc?.treasuryBps ?? 0,
  };
  const addrByBucket: Record<'founder' | 'levy' | 'treasury', string | null> = {
    founder: l.lockAddresses?.founder ?? null,
    levy: l.lockAddresses?.levy ?? null,
    treasury: l.lockAddresses?.treasury ?? null,
  };
  const buckets: LaunchBucketViewModel[] = (l.lockTerms ?? []).map((term) => ({
    bucket: term.bucket,
    recipient: term.recipient,
    amountBase: BigInt(term.amountBase),
    shareBps: bpsByBucket[term.bucket],
    cliffMonths: term.cliffMonths,
    linearMonths: term.linearMonths,
    lockAddress: addrByBucket[term.bucket],
  }));
  const listed = status === 'live' || status === 'graduated';
  // Creating the escrows and having the server verify them resolve together
  // (one submit runs both), so a confirmed mint sits on 'locks' until the
  // verification succeeds, which completes 'verify' too.
  const at = listed ? 4 : l.locksVerified ? 3 : l.mintConfirmed ? 1 : 0;
  const order: LaunchStep[] = ['mint', 'locks', 'verify', 'list'];
  const steps = order.map((step, i) => ({ step, done: i < at, current: i === at }));
  return {
    prepared: l.prepared,
    mint: l.mint,
    supplyBase: l.supplyBase === null ? null : BigInt(l.supplyBase),
    publicBps: l.alloc?.publicBps ?? 0,
    liquidityBps: l.alloc?.liquidityBps ?? 0,
    buckets,
    steps,
    mintConfirmed: l.mintConfirmed,
    locksVerified: l.locksVerified,
    needsLockAddresses: l.mintConfirmed && !l.locksVerified,
  };
}

// ── Curve (phase 4) view ─────────────────────────────────────────────────────

export interface CurveWire {
  host: 'meteora-dbc' | 'fixed-rate-stub' | null;
  config: {
    quoteMint: string;
    migrationQuoteThresholdBase: string;
    partnerLockedLpBps: number;
    creatorLockedLpBps: number;
  } | null;
  curve: {
    poolAddress: string;
    quoteReserveBase: string;
    progressBps: number;
    migrated: boolean;
  } | null;
  graduated: boolean;
  poolAddress: string | null;
  lpLockAddress: string | null;
}

export interface CurveViewModel {
  host: 'meteora-dbc' | 'fixed-rate-stub' | null;
  created: boolean;
  poolAddress: string | null;
  // 0..100 whole percent toward the migration threshold, for the progress bar.
  progressPct: number;
  raisedBase: bigint;
  thresholdBase: bigint;
  quoteDecimals: number; // SOL 9, SPL quote assets 6 (USDC-style display)
  lockedLpBps: number;
  migrated: boolean;
  graduated: boolean;
  dammPoolAddress: string | null;
}

export function curveView(c: CurveWire): CurveViewModel {
  return {
    host: c.host,
    created: c.curve !== null,
    poolAddress: c.curve?.poolAddress ?? null,
    progressPct: Math.min(100, Math.floor((c.curve?.progressBps ?? 0) / 100)),
    raisedBase: BigInt(c.curve?.quoteReserveBase ?? '0'),
    thresholdBase: BigInt(c.config?.migrationQuoteThresholdBase ?? '0'),
    quoteDecimals: (c.config?.quoteMint ?? '') === '' ? 9 : 6,
    lockedLpBps: (c.config?.partnerLockedLpBps ?? 0) + (c.config?.creatorLockedLpBps ?? 0),
    migrated: c.curve?.migrated ?? false,
    graduated: c.graduated,
    dammPoolAddress: c.poolAddress,
  };
}

// Basis points as a whole-ish percent string ("12" or "12.5"), exact.
export function bpsPercent(bps: number): string {
  const whole = Math.floor(bps / 100);
  const frac = bps % 100;
  if (frac === 0) return String(whole);
  const fracStr = String(frac).padStart(2, '0').replace(/0$/, '');
  return `${whole}.${fracStr}`;
}

// Parse a human amount string ("1.5") into base units at `decimals`, exactly.
// Returns null on anything malformed, negative, zero, or with more fractional
// digits than the currency carries. Pure bigint math (no float rounding).
export function parseAmountToBase(raw: string, decimals: number): bigint | null {
  const s = raw.trim();
  const m = /^([0-9]{1,15})(?:\.([0-9]{1,15}))?$/.exec(s);
  if (!m) return null;
  const frac = m[2] ?? '';
  if (frac.length > decimals) return null;
  const scaled = BigInt(m[1]) * 10n ** BigInt(decimals) + BigInt(frac.padEnd(decimals, '0') || '0');
  return scaled > 0n ? scaled : null;
}

// Whole-unit display of a base amount at `decimals`, trimming trailing zeros
// ("1.500000000" -> "1.5", "2.000000" -> "2"). Exact bigint string math; the
// painter passes the result through the locale formatter only when it is an
// integer (fractional strings render as-is to avoid float precision loss).
export function formatBaseAmount(amountBase: bigint, decimals: number): string {
  const negative = amountBase < 0n;
  const abs = negative ? -amountBase : amountBase;
  const unit = 10n ** BigInt(decimals);
  const whole = abs / unit;
  const frac = (abs % unit).toString().padStart(decimals, '0').replace(/0+$/, '');
  const body = frac.length > 0 ? `${whole.toString()}.${frac}` : whole.toString();
  return negative ? `-${body}` : body;
}
