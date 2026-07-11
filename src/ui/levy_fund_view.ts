// Pure view-core for the public Levy Street Fund portfolio page (launchpad
// phase 6): maps the server's display-only snapshot to a render model of
// pre-formatted strings and stable discriminators. DOM-free, i18n-free (the
// painter maps discriminators to launchpad.fund.* keys), Node-tested, and
// registered in UI_PURE_CORES.
//
// Display-only by construction: the model carries amounts, prices, weights,
// and proof links. No field of it can express a buy, sell, or redemption.

import { formatBaseAmount } from './realm_launchpad_view';

export interface FundHoldingWire {
  mint: string;
  realmId: number | null;
  symbol: string;
  amountBase: string;
  decimals: number;
  locked: boolean;
  graduated: boolean;
  priceUsd: number | null;
  valueUsd: number | null;
  weightBps: number;
  source: string;
  confidence: string;
  illiquid: boolean;
}

export interface FundWire {
  aumUsd: number;
  aumClamped: boolean;
  solUsd: number | null;
  updatedAt: string;
  holdings: FundHoldingWire[];
}

export interface FundHoldingRow {
  mint: string;
  symbol: string;
  amountText: string; // whole-token display, exact bigint string math
  priceUsd: number | null;
  valueUsd: number | null;
  weightPct: number; // whole percent, floored
  locked: boolean;
  graduated: boolean;
  source: 'curve' | 'jupiter' | 'none';
  confidence: 'high' | 'medium' | 'low';
  illiquid: boolean;
}

export interface FundViewModel {
  aumUsd: number;
  aumClamped: boolean;
  solUsd: number | null;
  updatedAt: string;
  rows: FundHoldingRow[];
  pricedCount: number;
  illiquidCount: number;
}

const SOURCES = new Set(['curve', 'jupiter', 'none']);
const CONFIDENCES = new Set(['high', 'medium', 'low']);

export function fundView(wire: FundWire): FundViewModel {
  const rows: FundHoldingRow[] = wire.holdings.map((h) => ({
    mint: h.mint,
    symbol: h.symbol,
    amountText: formatBaseAmount(BigInt(h.amountBase), h.decimals),
    priceUsd: h.priceUsd,
    valueUsd: h.valueUsd,
    weightPct: Math.floor(h.weightBps / 100),
    locked: h.locked,
    graduated: h.graduated,
    source: (SOURCES.has(h.source) ? h.source : 'none') as FundHoldingRow['source'],
    confidence: (CONFIDENCES.has(h.confidence)
      ? h.confidence
      : 'low') as FundHoldingRow['confidence'],
    illiquid: h.illiquid,
  }));
  return {
    aumUsd: wire.aumUsd,
    aumClamped: wire.aumClamped,
    solUsd: wire.solUsd,
    updatedAt: wire.updatedAt,
    rows,
    pricedCount: rows.filter((r) => !r.illiquid).length,
    illiquidCount: rows.filter((r) => r.illiquid).length,
  };
}
