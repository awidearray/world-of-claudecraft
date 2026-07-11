// Tiered, liquidity-aware token valuation (launchpad phase 6, PRD section 8).
// A holding's value = balance x price; the price SOURCE is tiered by the
// token's liquidity state, because no single feed covers the lifecycle:
//
//   pre-graduation (on the DBC curve, no DEX route yet):
//     read the pool's sqrtPrice for spot AND publish a SIZE-AWARE mark via the
//     venue's swapQuote against the actual held balance (realized quote-out,
//     not instantaneous spot), so a thin curve cannot inflate the mark.
//   post-graduation (a real route exists):
//     Jupiter Price API v3 as the primary USD source, cross-checked against
//     Birdeye and DEX Screener; if they diverge beyond a threshold, or pool
//     liquidity is below a floor, the token is marked ILLIQUID rather than
//     trusting the spot.
//   SOL/USD reference: one Pyth pull per refresh, carrying a confidence band;
//     a wide band or a stale feed flags the holding.
//
// Anti-manipulation + honesty (the daos.fun-clone bugs this avoids): value
// each holding off a short ROLLING MEDIAN of recent marks, CLAMP single-refresh
// AUM jumps pending confirmation, and EXCLUDE (never zero) illiquid / null-
// priced holdings from the AUM total.
//
// This module is PURE valuation logic over an injected `PriceSources` seam, so
// the tier selection, the sqrtPrice math, the divergence rejection, the median,
// and the clamp are all unit-tested with fixtures; the production wiring
// (real Jupiter / Birdeye / DEX Screener / Pyth fetches) is `realPriceSources`.

function numEnv(key: string, def: number, min: number, max: number): number {
  const v = Number.parseFloat(process.env[key] ?? '');
  return Number.isFinite(v) && v >= min && v <= max ? v : def;
}

// ── sqrtPrice -> price (pure) ─────────────────────────────────────────────────

// Meteora curve price from the pool sqrtPrice (Q64.64):
//   price = (sqrtPrice / 2^64)^2 x 10^(baseDec - quoteDec)
// returned as quote-per-base in HUMAN units. Computed in high-precision
// bigint-scaled arithmetic (no float sqrt), then divided down.
const PRICE_SCALE = 10n ** 18n; // 18 fractional digits of precision

export function priceFromSqrtPriceScaled(
  sqrtPrice: bigint,
  baseDecimals: number,
  quoteDecimals: number,
): bigint {
  // (sqrtPrice^2 / 2^128) is the raw base-unit price; scale up first to keep
  // precision, then apply the decimal shift.
  const q128 = 1n << 128n;
  let scaled = (sqrtPrice * sqrtPrice * PRICE_SCALE) / q128;
  const shift = baseDecimals - quoteDecimals;
  if (shift > 0) scaled *= 10n ** BigInt(shift);
  else if (shift < 0) scaled /= 10n ** BigInt(-shift);
  return scaled; // human quote per human base, x PRICE_SCALE
}

// ── The injected price seam ───────────────────────────────────────────────────

export interface JupiterPrice {
  mint: string;
  priceUsd: number; // USD per whole token, or NaN when Jupiter returns null
}

export interface CrossCheckPrice {
  priceUsd: number | null; // null when the source has no data / no pool
  liquidityUsd: number | null; // pool liquidity, null when unknown
}

export interface PythSolUsd {
  priceUsd: number;
  confIntervalUsd: number; // the confidence band half-width
  stale: boolean;
}

export interface CurveMark {
  // Human quote per whole token, size-aware (quote-out for the held balance
  // divided by the held balance), plus the pool's spot sqrtPrice-derived price.
  sizeAwareQuotePerToken: number | null; // null when the curve cannot quote the size (illiquid)
  spotQuotePerToken: number;
}

export interface PriceSources {
  // Batched Jupiter Price v3 (50 mints per call in the production wiring).
  jupiterPrices(mints: string[]): Promise<Map<string, JupiterPrice>>;
  birdeyePrice(mint: string): Promise<CrossCheckPrice>;
  dexScreenerPrice(mint: string): Promise<CrossCheckPrice>;
  pythSolUsd(): Promise<PythSolUsd>;
  // Pre-graduation curve mark for a held balance, via the venue's live pool.
  curveMark(
    poolAddress: string,
    heldBalanceBase: bigint,
    decimals: number,
  ): Promise<CurveMark | null>;
}

// ── Tiered valuation (pure over PriceSources) ────────────────────────────────

export type ValuationSource = 'dbc_curve' | 'jupiter_v3' | 'none';

export interface HoldingInput {
  mint: string;
  decimals: number;
  amountBase: bigint;
  // The realm's launch lifecycle: 'live' is on the curve (pre-graduation);
  // 'graduated' has a DEX route.
  graduated: boolean;
  poolAddress: string | null;
}

export interface HoldingValuation {
  mint: string;
  amountBase: bigint;
  amountHuman: number;
  priceUsd: number | null; // USD per whole token, null when illiquid
  valueUsd: number | null;
  valueSol: number | null;
  source: ValuationSource;
  illiquid: boolean;
  // Why it was excluded, when illiquid (for the dashboard's per-row tag).
  note: string | null;
}

// The cross-check divergence threshold: if the primary and a cross source
// disagree by more than this fraction, the token is marked illiquid.
function divergenceThreshold(): number {
  return numEnv('LEVY_PRICE_DIVERGENCE_MAX', 0.25, 0.01, 1);
}
// The minimum cross-source pool liquidity (USD) to trust a post-grad price.
function liquidityFloorUsd(): number {
  return numEnv('LEVY_LIQUIDITY_FLOOR_USD', 500, 0, 1_000_000_000);
}
// The maximum Pyth confidence band (fraction of price) before SOL/USD is flagged.
function pythConfMaxFraction(): number {
  return numEnv('LEVY_PYTH_CONF_MAX', 0.05, 0.001, 0.5);
}

function humanAmount(amountBase: bigint, decimals: number): number {
  // Exact-ish: split integer and fractional so a whale balance keeps precision.
  const per = 10n ** BigInt(decimals);
  const whole = amountBase / per;
  const frac = amountBase % per;
  return Number(whole) + Number(frac) / Number(per);
}

// Value a single holding on the tiered pipeline. `solUsd` is the current Pyth
// SOL/USD (already validated by the caller); a wide/stale band makes valueSol
// null but leaves valueUsd intact.
export async function valueHolding(
  holding: HoldingInput,
  sources: PriceSources,
  jup: Map<string, JupiterPrice>,
  solUsd: { priceUsd: number; reliable: boolean },
): Promise<HoldingValuation> {
  const amountHuman = humanAmount(holding.amountBase, holding.decimals);
  const excluded = (source: ValuationSource, note: string): HoldingValuation => ({
    mint: holding.mint,
    amountBase: holding.amountBase,
    amountHuman,
    priceUsd: null,
    valueUsd: null,
    valueSol: null,
    source,
    illiquid: true,
    note,
  });

  if (holding.amountBase <= 0n) return excluded('none', 'zero balance');

  if (!holding.graduated) {
    // Pre-graduation: the curve is the only price. A size-aware quote against
    // the held balance is the mark; if the curve cannot quote the size, the
    // holding is illiquid (excluded, never zeroed).
    if (holding.poolAddress === null) return excluded('dbc_curve', 'no pool');
    const mark = await sources.curveMark(holding.poolAddress, holding.amountBase, holding.decimals);
    if (!mark || mark.sizeAwareQuotePerToken === null) {
      return excluded('dbc_curve', 'curve cannot quote size');
    }
    // The curve quote is in SOL (the quote asset); convert to USD via Pyth.
    if (!solUsd.reliable) return excluded('dbc_curve', 'SOL/USD unreliable');
    const priceUsd = mark.sizeAwareQuotePerToken * solUsd.priceUsd;
    const valueUsd = amountHuman * priceUsd;
    return {
      mint: holding.mint,
      amountBase: holding.amountBase,
      amountHuman,
      priceUsd,
      valueUsd,
      valueSol: amountHuman * mark.sizeAwareQuotePerToken,
      source: 'dbc_curve',
      illiquid: false,
      note: null,
    };
  }

  // Post-graduation: Jupiter v3 primary, cross-checked against Birdeye + DEX
  // Screener. Diverge beyond the threshold or below the liquidity floor -> mark
  // illiquid rather than trust the spot.
  const jp = jup.get(holding.mint);
  if (!jp || !Number.isFinite(jp.priceUsd) || jp.priceUsd <= 0) {
    return excluded('jupiter_v3', 'no Jupiter route');
  }
  const [birdeye, dex] = await Promise.all([
    sources.birdeyePrice(holding.mint),
    sources.dexScreenerPrice(holding.mint),
  ]);
  const crossPrices = [birdeye.priceUsd, dex.priceUsd].filter(
    (p): p is number => p !== null && Number.isFinite(p) && p > 0,
  );
  if (crossPrices.length === 0) return excluded('jupiter_v3', 'no cross-check source');
  const worstDivergence = Math.max(
    ...crossPrices.map((p) => Math.abs(p - jp.priceUsd) / jp.priceUsd),
  );
  if (worstDivergence > divergenceThreshold()) {
    return excluded('jupiter_v3', 'price sources diverge');
  }
  const liquidity = [birdeye.liquidityUsd, dex.liquidityUsd].filter(
    (l): l is number => l !== null && Number.isFinite(l),
  );
  if (liquidity.length > 0 && Math.max(...liquidity) < liquidityFloorUsd()) {
    return excluded('jupiter_v3', 'pool liquidity below floor');
  }
  const valueUsd = amountHuman * jp.priceUsd;
  return {
    mint: holding.mint,
    amountBase: holding.amountBase,
    amountHuman,
    priceUsd: jp.priceUsd,
    valueUsd,
    valueSol: solUsd.reliable ? valueUsd / solUsd.priceUsd : null,
    source: 'jupiter_v3',
    illiquid: false,
    note: null,
  };
}

// Whether a Pyth SOL/USD reading is reliable enough to convert with.
export function pythReliable(pyth: PythSolUsd): boolean {
  if (pyth.stale || !Number.isFinite(pyth.priceUsd) || pyth.priceUsd <= 0) return false;
  return pyth.confIntervalUsd / pyth.priceUsd <= pythConfMaxFraction();
}

// ── Rolling median + AUM clamp (pure) ─────────────────────────────────────────

// A short rolling median of recent per-mint USD marks. Smooths a single thin-
// pool spike without lagging a real move for long. `recent` is oldest-first.
export function rollingMedianUsd(recent: number[], fresh: number, window: number): number {
  const series = [...recent, fresh].slice(-window);
  const sorted = [...series].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

// Clamp a single-refresh AUM jump: if the fresh AUM moves more than
// `maxJumpFraction` from the previous, hold it at the clamped bound pending
// confirmation (a persisted jump surfaces over subsequent refreshes). Returns
// the AUM to publish plus whether it was clamped.
export function clampAumJump(
  previousAum: number | null,
  freshAum: number,
  maxJumpFraction: number,
): { aum: number; clamped: boolean } {
  if (previousAum === null || previousAum <= 0) return { aum: freshAum, clamped: false };
  const upper = previousAum * (1 + maxJumpFraction);
  const lower = previousAum * (1 - maxJumpFraction);
  if (freshAum > upper) return { aum: upper, clamped: true };
  if (freshAum < lower) return { aum: lower, clamped: true };
  return { aum: freshAum, clamped: false };
}

export function aumClampFraction(): number {
  return numEnv('LEVY_AUM_CLAMP_MAX', 0.5, 0.05, 5);
}
export function medianWindow(): number {
  return Math.round(numEnv('LEVY_MEDIAN_WINDOW', 5, 1, 50));
}
