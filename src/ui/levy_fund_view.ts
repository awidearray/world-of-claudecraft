// Levy Street Fund portfolio view-core (launchpad phase 6). Pure, DOM-free,
// Node-tested; registered in UI_PURE_CORES (tests/architecture.test.ts). Maps
// the public /api/levy-fund payload into a render model for the display-only
// portfolio panel: the AUM header, and one sorted row per holding with its
// value, weight, and (when excluded) illiquid tag. There is deliberately no
// buy / sell / redeem affordance anywhere in this model (PRD section 8).

export interface LevyHoldingWire {
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
}

export interface LevyPortfolioWire {
  aumUsd: number;
  aumSol: number | null;
  holdingCount: number;
  includedCount: number;
  clamped: boolean;
  solUsd: number | null;
  updatedAt: string | null;
  holdings: LevyHoldingWire[];
}

export interface LevyHoldingRowModel {
  realmId: number;
  mint: string;
  symbol: string;
  valueUsd: number | null;
  valueSol: number | null;
  priceUsd: number | null;
  weightPct: number;
  source: string;
  illiquid: boolean;
  note: string | null;
  lockAddress: string | null;
}

export interface LevyPortfolioModel {
  aumUsd: number;
  aumSol: number | null;
  holdingCount: number;
  includedCount: number;
  excludedCount: number;
  clamped: boolean;
  empty: boolean;
  updatedAt: string | null;
  rows: LevyHoldingRowModel[];
}

// Build the portfolio render model. Rows are sorted value-desc with illiquid
// (unvalued) rows last; weights render as percents (bps / 100).
export function levyPortfolioView(wire: LevyPortfolioWire): LevyPortfolioModel {
  const rows: LevyHoldingRowModel[] = wire.holdings.map((h) => ({
    realmId: h.realmId,
    mint: h.mint,
    symbol: h.symbol,
    valueUsd: h.valueUsd,
    valueSol: h.valueSol,
    priceUsd: h.priceUsd,
    weightPct: h.weightBps / 100,
    source: h.source,
    illiquid: h.illiquid,
    note: h.note,
    lockAddress: h.lockAddress,
  }));
  rows.sort((a, b) => {
    if (a.illiquid !== b.illiquid) return a.illiquid ? 1 : -1;
    return (b.valueUsd ?? 0) - (a.valueUsd ?? 0);
  });
  const excludedCount = wire.holdings.filter((h) => h.illiquid).length;
  return {
    aumUsd: wire.aumUsd,
    aumSol: wire.aumSol,
    holdingCount: wire.holdingCount,
    includedCount: wire.includedCount,
    excludedCount,
    clamped: wire.clamped,
    empty: wire.holdingCount === 0,
    updatedAt: wire.updatedAt,
    rows,
  };
}
