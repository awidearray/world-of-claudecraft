// The Levy Street Fund (launchpad phase 6, PRD section 8): the platform-owned
// treasury that ends up holding a slice (default 8 percent) of every realm
// token launched on the platform, DISPLAYED daos.fun-style as a live portfolio
// of holdings.
//
// THE ABSOLUTE LINE (PRD sections 8 + 14, the single largest securities risk in
// the whole design): this is DISPLAY-ONLY. It mints NO fund-share token, sells
// NO claim on the portfolio, and offers NO pro-rata redemption. There is no
// buy, sell, deposit, withdraw, or redeem path anywhere in this module or its
// DB layer. The only writes are the valuation keeper's cached snapshots; the
// only reads are the public portfolio page. That distinction is what keeps the
// platform out of investment-company / pooled-investment-vehicle territory, and
// it is asserted by a source-scan test.
//
// The valuation keeper enumerates the fund's holdings (the levy allocation of
// every launched realm token, locked or not), prices each on the tiered
// pipeline (token_valuation.ts), applies a rolling median per mint and an AUM
// clamp, and writes a `levy_fund_holdings` snapshot. The dashboard reads the
// snapshot, never the chain.

import {
  aumClampFraction,
  clampAumJump,
  type HoldingValuation,
  medianWindow,
  type PriceSources,
  pythReliable,
  rollingMedianUsd,
  type ValuationSource,
  valueHolding,
} from './token_valuation';

export interface LevyHoldingRow {
  realmId: number;
  mint: string;
  symbol: string;
  amountBase: bigint;
  decimals: number;
  priceUsd: number | null;
  valueUsd: number | null;
  valueSol: number | null;
  weightBps: number;
  source: string;
  illiquid: boolean;
  note: string | null;
  lockAddress: string | null;
}

export interface LevySnapshot {
  snapshotId: number;
  aumUsd: number;
  aumSol: number | null;
  holdingCount: number;
  includedCount: number;
  clamped: boolean;
  solUsd: number | null;
  createdAt: Date;
  holdings: LevyHoldingRow[];
}

export interface LevyHoldingSource {
  realmId: number;
  mint: string;
  symbol: string;
  decimals: number;
  levyAllocBase: bigint;
  poolAddress: string | null;
  status: string;
  levyLockAddress: string | null;
}

// The SQL surface levy_fund_db.ts implements; tests fake it in memory. Note
// the ONLY writes are snapshots + marks: no position, no share, no redemption.
export interface LevyFundStore {
  holdingSources(): Promise<LevyHoldingSource[]>;
  recentMarks(mint: string, window: number): Promise<number[]>;
  insertMark(mint: string, priceUsd: number): Promise<void>;
  previousAum(): Promise<number | null>;
  insertSnapshot(s: {
    aumUsd: number;
    aumSol: number | null;
    holdingCount: number;
    includedCount: number;
    clamped: boolean;
    solUsd: number | null;
    holdings: LevyHoldingRow[];
  }): Promise<number>;
  latestSnapshot(): Promise<LevySnapshot | null>;
}

export interface LevyFundDeps {
  store: LevyFundStore;
  sources: PriceSources;
}

// One valuation refresh: price every holding on the tiered pipeline, median-
// smooth each mint's USD mark, exclude (never zero) illiquid holdings from the
// AUM, clamp the single-refresh AUM jump, and persist a snapshot. Returns the
// snapshot id, or null when there is nothing to value.
export async function refreshLevyFund(deps: LevyFundDeps): Promise<number | null> {
  const holdings = await deps.store.holdingSources();
  if (holdings.length === 0) return null;

  // One Pyth pull per refresh.
  const pyth = await deps.sources.pythSolUsd();
  const solUsd = { priceUsd: pyth.priceUsd, reliable: pythReliable(pyth) };

  // Batched Jupiter prices for the graduated mints.
  const graduatedMints = holdings.filter((h) => h.status === 'graduated').map((h) => h.mint);
  const jup =
    graduatedMints.length > 0 ? await deps.sources.jupiterPrices(graduatedMints) : new Map();

  const window = medianWindow();
  const rows: LevyHoldingRow[] = [];
  for (const h of holdings) {
    const valuation = await valueHolding(
      {
        mint: h.mint,
        decimals: h.decimals,
        amountBase: h.levyAllocBase,
        graduated: h.status === 'graduated',
        poolAddress: h.poolAddress,
      },
      deps.sources,
      jup,
      solUsd,
    );
    rows.push(await smoothAndRow(deps, h, valuation, window, solUsd));
  }

  const included = rows.filter((r) => !r.illiquid && r.valueUsd !== null);
  const freshAum = included.reduce((s, r) => s + (r.valueUsd ?? 0), 0);
  const previous = await deps.store.previousAum();
  const { aum, clamped } = clampAumJump(previous, freshAum, aumClampFraction());
  const aumSol = solUsd.reliable ? aum / solUsd.priceUsd : null;

  // Weights are of the INCLUDED AUM (illiquid rows carry weight 0).
  for (const r of rows) {
    r.weightBps =
      !r.illiquid && r.valueUsd !== null && aum > 0 ? Math.round((r.valueUsd / aum) * 10_000) : 0;
  }

  return deps.store.insertSnapshot({
    aumUsd: aum,
    aumSol,
    holdingCount: rows.length,
    includedCount: included.length,
    clamped,
    solUsd: solUsd.reliable ? solUsd.priceUsd : null,
    holdings: rows,
  });
}

// Apply the per-mint rolling median to a fresh liquid mark, record the mark,
// and shape the holding row. Illiquid holdings pass through unpriced (excluded
// from AUM, never zeroed).
async function smoothAndRow(
  deps: LevyFundDeps,
  source: LevyHoldingSource,
  v: HoldingValuation,
  window: number,
  solUsd: { priceUsd: number; reliable: boolean },
): Promise<LevyHoldingRow> {
  let priceUsd = v.priceUsd;
  let valueUsd = v.valueUsd;
  let valueSol = v.valueSol;
  if (!v.illiquid && v.priceUsd !== null) {
    const recent = await deps.store.recentMarks(source.mint, window - 1);
    const median = rollingMedianUsd(recent, v.priceUsd, window);
    await deps.store.insertMark(source.mint, v.priceUsd);
    priceUsd = median;
    valueUsd = v.amountHuman * median;
    valueSol = solUsd.reliable ? valueUsd / solUsd.priceUsd : null;
  }
  return {
    realmId: source.realmId,
    mint: source.mint,
    symbol: source.symbol,
    amountBase: source.levyAllocBase,
    decimals: source.decimals,
    priceUsd,
    valueUsd,
    valueSol,
    weightBps: 0, // filled after the AUM is known
    source: v.source as ValuationSource,
    illiquid: v.illiquid,
    note: v.note,
    lockAddress: source.levyLockAddress,
  };
}

// ── The public portfolio read (display-only) ──────────────────────────────────

export interface LevyPortfolioView {
  aumUsd: number;
  aumSol: number | null;
  holdingCount: number;
  includedCount: number;
  clamped: boolean;
  solUsd: number | null;
  updatedAt: string | null;
  holdings: Array<{
    realmId: number;
    mint: string;
    symbol: string;
    amount: string;
    priceUsd: number | null;
    valueUsd: number | null;
    valueSol: number | null;
    weightBps: number;
    source: string;
    illiquid: boolean;
    note: string | null;
    lockAddress: string | null;
  }>;
}

// The public dashboard payload from the latest cached snapshot. NO controls: no
// buy, sell, or redeem field exists in this shape by design.
export async function levyPortfolio(store: LevyFundStore): Promise<LevyPortfolioView> {
  const snap = await store.latestSnapshot();
  if (!snap) {
    return {
      aumUsd: 0,
      aumSol: null,
      holdingCount: 0,
      includedCount: 0,
      clamped: false,
      solUsd: null,
      updatedAt: null,
      holdings: [],
    };
  }
  return {
    aumUsd: snap.aumUsd,
    aumSol: snap.aumSol,
    holdingCount: snap.holdingCount,
    includedCount: snap.includedCount,
    clamped: snap.clamped,
    solUsd: snap.solUsd,
    updatedAt: snap.createdAt.toISOString(),
    holdings: snap.holdings.map((h) => ({
      realmId: h.realmId,
      mint: h.mint,
      symbol: h.symbol,
      amount: h.amountBase.toString(),
      priceUsd: h.priceUsd,
      valueUsd: h.valueUsd,
      valueSol: h.valueSol,
      weightBps: h.weightBps,
      source: h.source,
      illiquid: h.illiquid,
      note: h.note,
      lockAddress: h.lockAddress,
    })),
  };
}
