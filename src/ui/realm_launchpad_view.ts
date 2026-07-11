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
