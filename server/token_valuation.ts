// Tiered, liquidity-aware token valuation (launchpad phase 6, PRD sections
// 5.11 + 8). PURE: every function here maps already-fetched inputs to marks;
// the fetchers live in levy_fund_sources.ts / realm_launchpad_dbc.ts.
//
// The tiers, per the PRD:
//  - Pre-graduation (on the DBC curve, no DEX route): the mark is SIZE-AWARE,
//    the realized quote-out of swapping the fund's ACTUAL balance against the
//    curve (never the instantaneous spot, which a thin curve inflates). The
//    sqrtPrice spot is computed for reference only.
//  - Post-graduation: Jupiter Price v3 is the primary USD source, CROSS-CHECKED
//    against Birdeye / DEX Screener; divergence beyond the threshold marks the
//    holding ILLIQUID rather than trusting either spot.
//  - SOL/USD comes from one Pyth pull carrying a confidence band; a wide or
//    stale band downgrades confidence (flagged, still counted).
//  - Illiquid / unpriceable holdings are EXCLUDED from AUM, never zeroed (the
//    bug daos.fun clones repeatedly ship), and each mark is smoothed with a
//    short rolling median with single-refresh AUM jumps clamped pending
//    confirmation.

// price of one whole base token in quote units, from a Q64.64 sqrt price:
// price = (sqrtPrice / 2^64)^2 * 10^(baseDecimals - quoteDecimals).
// Display-precision math (number), used for reference spots only; AUM never
// derives from this when a size-aware quote is available.
export function priceFromSqrtPrice(
  sqrtPrice: bigint,
  baseDecimals: number,
  quoteDecimals: number,
): number {
  const ratio = Number(sqrtPrice) / 2 ** 64;
  return ratio * ratio * 10 ** (baseDecimals - quoteDecimals);
}

export interface PythSolUsd {
  price: number;
  confidenceBps: number; // conf / price in bps
  stale: boolean;
}

export type MarkSource = 'curve' | 'jupiter' | 'none';
export type MarkConfidence = 'high' | 'medium' | 'low';

// The per-mint inputs the valuation combines; every field is what a fetcher
// managed to read, null when unreadable. Amounts are base units.
export interface HoldingInput {
  mint: string;
  realmId: number | null;
  symbol: string;
  amountBase: bigint;
  decimals: number;
  locked: boolean;
  graduated: boolean;
  // Pre-graduation: the realized quote-out of selling amountBase into the
  // curve, in quote base units, and whether the quote asset is native SOL.
  curveQuoteOutBase: bigint | null;
  quoteIsSol: boolean;
  quoteDecimals: number;
  // Post-graduation: USD spots.
  jupiterUsd: number | null;
  crossUsd: number | null; // Birdeye or DEX Screener, whichever is configured
}

export interface HoldingMark {
  mint: string;
  realmId: number | null;
  symbol: string;
  amountBase: bigint;
  decimals: number;
  locked: boolean;
  graduated: boolean;
  priceUsd: number | null; // per whole token
  valueUsd: number | null; // for the full holding
  source: MarkSource;
  confidence: MarkConfidence;
  illiquid: boolean;
}

export interface ValuationConfig {
  // Post-grad primary/cross divergence beyond this marks the holding illiquid.
  divergenceBps: number;
  // A Pyth band wider than this (or a stale pull) downgrades confidence.
  pythMaxConfidenceBps: number;
}

export const DEFAULT_VALUATION_CONFIG: ValuationConfig = {
  divergenceBps: 2500,
  pythMaxConfidenceBps: 200,
};

function whole(amountBase: bigint, decimals: number): number {
  return Number(amountBase) / 10 ** decimals;
}

// Mark one holding on the tiered pipeline. Pure; unit-tested per tier.
export function markHolding(
  input: HoldingInput,
  pyth: PythSolUsd | null,
  config: ValuationConfig = DEFAULT_VALUATION_CONFIG,
): HoldingMark {
  const base = {
    mint: input.mint,
    realmId: input.realmId,
    symbol: input.symbol,
    amountBase: input.amountBase,
    decimals: input.decimals,
    locked: input.locked,
    graduated: input.graduated,
  };
  const excluded = (): HoldingMark => ({
    ...base,
    priceUsd: null,
    valueUsd: null,
    source: 'none',
    confidence: 'low',
    illiquid: true,
  });

  if (input.amountBase <= 0n) return excluded();

  if (!input.graduated) {
    // Curve tier: value = the realized quote-out of the fund's actual balance.
    if (input.curveQuoteOutBase === null || input.curveQuoteOutBase <= 0n) return excluded();
    const quoteWhole = whole(input.curveQuoteOutBase, input.quoteDecimals);
    let quoteUsd: number;
    let confidence: MarkConfidence = 'high';
    if (input.quoteIsSol) {
      if (!pyth || pyth.price <= 0) return excluded();
      quoteUsd = pyth.price;
      if (pyth.stale || pyth.confidenceBps > config.pythMaxConfidenceBps) confidence = 'low';
    } else {
      quoteUsd = 1; // a USD-stable quote asset (USDC-style)
      confidence = 'medium';
    }
    const valueUsd = quoteWhole * quoteUsd;
    const amountWhole = whole(input.amountBase, input.decimals);
    return {
      ...base,
      priceUsd: amountWhole > 0 ? valueUsd / amountWhole : null,
      valueUsd,
      source: 'curve',
      confidence,
      illiquid: false,
    };
  }

  // DEX tier: Jupiter primary, cross-checked. No primary spot = illiquid.
  if (input.jupiterUsd === null || input.jupiterUsd <= 0) return excluded();
  let confidence: MarkConfidence = 'medium';
  if (input.crossUsd !== null && input.crossUsd > 0) {
    const divergence =
      Math.abs(input.jupiterUsd - input.crossUsd) / Math.max(input.jupiterUsd, input.crossUsd);
    if (divergence * 10_000 > config.divergenceBps) return excluded();
    confidence = 'high';
  }
  const valueUsd = whole(input.amountBase, input.decimals) * input.jupiterUsd;
  return {
    ...base,
    priceUsd: input.jupiterUsd,
    valueUsd,
    source: 'jupiter',
    confidence,
    illiquid: false,
  };
}

// Short rolling median over the recent marks for one mint (anti-manipulation:
// a single spoofed refresh cannot move the published price). Exact for both
// parities; empty input returns null.
export function rollingMedian(prices: readonly number[]): number | null {
  if (prices.length === 0) return null;
  const sorted = [...prices].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

// Clamp a single-refresh AUM jump: a move beyond maxJumpRatio (either
// direction) publishes the PREVIOUS total flagged as clamped, pending a
// confirming refresh. First snapshot (no previous) always publishes.
export function clampAum(
  previousAumUsd: number | null,
  newAumUsd: number,
  maxJumpRatio = 1.5,
): { aumUsd: number; clamped: boolean } {
  if (previousAumUsd === null || previousAumUsd <= 0) return { aumUsd: newAumUsd, clamped: false };
  const upper = previousAumUsd * maxJumpRatio;
  const lower = previousAumUsd / maxJumpRatio;
  if (newAumUsd > upper || newAumUsd < lower) return { aumUsd: previousAumUsd, clamped: true };
  return { aumUsd: newAumUsd, clamped: false };
}

// The published AUM: the sum of PRICED holdings only. Illiquid holdings are
// excluded (never zeroed) and reported separately so the page can show them.
export function totalAumUsd(marks: readonly HoldingMark[]): number {
  let total = 0;
  for (const m of marks) if (!m.illiquid && m.valueUsd !== null) total += m.valueUsd;
  return total;
}
