// The Levy Street Fund (launchpad phase 6, PRD section 8): the platform-owned
// treasury wallet that receives every realm token's levy allocation, valued on
// the tiered pipeline (token_valuation.ts) and published as a DISPLAY-ONLY,
// daos.fun-style portfolio.
//
// THE ABSOLUTE LINE (PRD sections 8 + 14): this fund mints NO share token,
// sells NO claim on the portfolio, and offers NO redemption. Nothing in this
// module, its store, or its public payload exposes a buy, sell, or redeem
// operation; the module's whole write surface is a valuation snapshot. That
// display-only posture is what keeps the platform out of pooled-investment-
// vehicle territory, and it is pinned by test.
//
// The valuation keeper enumerates the fund wallet's holdings, joins them to
// the realm token registry (plus each verified levy LOCK as a locked row: the
// escrowed bag is the fund's primary form), prices them per tier, smooths each
// mark with a short rolling median, clamps single-refresh AUM jumps, and
// writes the snapshot the public read serves: the page never reads the chain.
//
// No SQL here (levy_fund_db.ts) and no fetch here (levy_fund_sources.ts).

import type { HoldingInput, HoldingMark, PythSolUsd, ValuationConfig } from './token_valuation';
import {
  clampAum,
  DEFAULT_VALUATION_CONFIG,
  markHolding,
  rollingMedian,
  totalAumUsd,
} from './token_valuation';

// One position the keeper discovered: a wallet balance (liquid) or a verified
// levy-lock escrow bag (locked), already joined to the registry.
export interface FundPosition {
  mint: string;
  realmId: number | null;
  symbol: string;
  amountBase: bigint;
  decimals: number;
  locked: boolean;
  graduated: boolean;
  // The curve pool for live (pre-graduation) tokens, for the size-aware quote.
  curveAddress: string | null;
}

export interface LevyFundStore {
  saveSnapshot(snapshot: {
    holdings: HoldingMark[];
    aumUsd: number;
    aumClamped: boolean;
    solUsd: number | null;
  }): Promise<void>;
  readSnapshot(): Promise<LevyFundSnapshot | null>;
  previousAumUsd(): Promise<number | null>;
  // The recent mark history for one mint (newest first), for the median.
  recentMarks(mint: string, limit: number): Promise<number[]>;
  appendMark(mint: string, priceUsd: number): Promise<void>;
}

export interface LevyFundSources {
  // Every position the fund holds: wallet balances + verified levy locks.
  listPositions(fundWallet: string): Promise<FundPosition[] | null>;
  // Size-aware realized quote-out of selling amountBase into the curve.
  curveQuoteOut(args: {
    poolAddress: string;
    amountBase: bigint;
  }): Promise<{ quoteOutBase: bigint; quoteIsSol: boolean; quoteDecimals: number } | null>;
  // Jupiter Price v3, batched.
  jupiterPricesUsd(mints: string[]): Promise<Map<string, number>>;
  // The cross-check spot (Birdeye when keyed, else DEX Screener).
  crossPriceUsd(mint: string): Promise<number | null>;
  pythSolUsd(): Promise<PythSolUsd | null>;
}

export interface LevyFundDeps {
  sources: LevyFundSources;
  store: LevyFundStore;
  fundWallet: string;
  medianWindow: number;
  config?: ValuationConfig;
}

// One valuation refresh: discover, price per tier, median-smooth, clamp, save.
export async function refreshLevyFund(deps: LevyFundDeps): Promise<boolean> {
  const positions = await deps.sources.listPositions(deps.fundWallet);
  if (positions === null) return false; // unreadable chain: keep the last snapshot

  const pyth = await deps.sources.pythSolUsd();
  const graduatedMints = positions.filter((p) => p.graduated).map((p) => p.mint);
  const jupiter = await deps.sources.jupiterPricesUsd([...new Set(graduatedMints)]);

  const marks: HoldingMark[] = [];
  for (const position of positions) {
    let curveQuoteOutBase: bigint | null = null;
    let quoteIsSol = true;
    let quoteDecimals = 9;
    if (!position.graduated && position.curveAddress && position.amountBase > 0n) {
      const quote = await deps.sources.curveQuoteOut({
        poolAddress: position.curveAddress,
        amountBase: position.amountBase,
      });
      if (quote) {
        curveQuoteOutBase = quote.quoteOutBase;
        quoteIsSol = quote.quoteIsSol;
        quoteDecimals = quote.quoteDecimals;
      }
    }
    const jupiterUsd = position.graduated ? (jupiter.get(position.mint) ?? null) : null;
    const crossUsd =
      position.graduated && jupiterUsd !== null
        ? await deps.sources.crossPriceUsd(position.mint)
        : null;
    const input: HoldingInput = {
      mint: position.mint,
      realmId: position.realmId,
      symbol: position.symbol,
      amountBase: position.amountBase,
      decimals: position.decimals,
      locked: position.locked,
      graduated: position.graduated,
      curveQuoteOutBase,
      quoteIsSol,
      quoteDecimals,
      jupiterUsd,
      crossUsd,
    };
    const mark = markHolding(input, pyth, deps.config ?? DEFAULT_VALUATION_CONFIG);
    marks.push(await smooth(deps, mark));
  }

  const previous = await deps.store.previousAumUsd();
  const { aumUsd, clamped } = clampAum(previous, totalAumUsd(marks));
  await deps.store.saveSnapshot({
    holdings: marks,
    aumUsd,
    aumClamped: clamped,
    solUsd: pyth?.price ?? null,
  });
  return true;
}

// Median-smooth one mark against its recent history: the published price is
// the median of the last N marks including this refresh. The raw mark is
// appended to the history either way; an illiquid mark contributes nothing.
async function smooth(deps: LevyFundDeps, mark: HoldingMark): Promise<HoldingMark> {
  if (mark.illiquid || mark.priceUsd === null) return mark;
  await deps.store.appendMark(mark.mint, mark.priceUsd);
  const recent = await deps.store.recentMarks(mark.mint, deps.medianWindow);
  const median = rollingMedian(recent);
  if (median === null || median <= 0) return mark;
  const amountWhole = Number(mark.amountBase) / 10 ** mark.decimals;
  return { ...mark, priceUsd: median, valueUsd: amountWhole * median };
}

// ── Position composition (pure) ──────────────────────────────────────────────

export interface RegistryTokenRow {
  realmId: number;
  mint: string;
  symbol: string;
  decimals: number;
  status: string;
  curveAddress: string | null;
}

export interface LevyLockRow {
  realmId: number;
  mint: string;
  symbol: string;
  decimals: number;
  status: string;
  curveAddress: string | null;
  levyBase: bigint;
}

// Join the fund wallet's balances and the verified levy locks to the realm
// token registry. Wallet balances on mints OUTSIDE the registry are ignored
// (the fund page shows realm tokens, not stray dust); the locked escrow bags
// are first-class rows: the levy allocation's primary form is the lock.
export function composePositions(args: {
  balances: ReadonlyMap<string, bigint>;
  tokens: readonly RegistryTokenRow[];
  levyLocks: readonly LevyLockRow[];
}): FundPosition[] {
  const positions: FundPosition[] = [];
  const byMint = new Map(args.tokens.map((t) => [t.mint, t]));
  for (const [mint, amountBase] of args.balances) {
    const token = byMint.get(mint);
    if (!token || amountBase <= 0n) continue;
    positions.push({
      mint,
      realmId: token.realmId,
      symbol: token.symbol,
      amountBase,
      decimals: token.decimals,
      locked: false,
      graduated: token.status === 'graduated',
      curveAddress: token.status === 'live' ? token.curveAddress : null,
    });
  }
  for (const lock of args.levyLocks) {
    if (lock.levyBase <= 0n) continue;
    positions.push({
      mint: lock.mint,
      realmId: lock.realmId,
      symbol: lock.symbol,
      amountBase: lock.levyBase,
      decimals: lock.decimals,
      locked: true,
      graduated: lock.status === 'graduated',
      curveAddress: lock.status === 'live' ? lock.curveAddress : null,
    });
  }
  return positions;
}

// ── Public portfolio payload (display-only) ──────────────────────────────────

export interface LevyFundHoldingView {
  mint: string;
  realmId: number | null;
  symbol: string;
  amountBase: string;
  decimals: number;
  locked: boolean;
  graduated: boolean;
  priceUsd: number | null;
  valueUsd: number | null;
  weightBps: number; // of the priced AUM; 0 for illiquid rows
  source: string;
  confidence: string;
  illiquid: boolean;
}

export interface LevyFundSnapshot {
  aumUsd: number;
  aumClamped: boolean;
  solUsd: number | null;
  updatedAt: string;
  holdings: LevyFundHoldingView[];
}

// The daos.fun-style page payload: AUM + one row per holding, sorted by value
// with illiquid rows flagged at the bottom. STRICTLY display data: no order,
// swap, redeem, or share fields exist anywhere in this shape.
export function portfolioView(snapshot: LevyFundSnapshot | null): LevyFundSnapshot | null {
  if (!snapshot) return null;
  const priced = snapshot.holdings.filter((h) => !h.illiquid && h.valueUsd !== null);
  const total = priced.reduce((sum, h) => sum + (h.valueUsd ?? 0), 0);
  const withWeights = snapshot.holdings.map((h) => ({
    ...h,
    weightBps:
      !h.illiquid && h.valueUsd !== null && total > 0
        ? Math.round((h.valueUsd / total) * 10_000)
        : 0,
  }));
  withWeights.sort((a, b) => {
    if (a.illiquid !== b.illiquid) return a.illiquid ? 1 : -1;
    return (b.valueUsd ?? 0) - (a.valueUsd ?? 0);
  });
  return { ...snapshot, holdings: withWeights };
}
