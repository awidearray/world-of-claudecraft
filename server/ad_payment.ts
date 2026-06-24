// Multi-asset on-chain verification for ad purchases (USDC / native SOL / $WOC),
// built on the asset-agnostic primitives in server/solana_tx.ts. Mirrors
// server/woc_payment.ts but generalizes across three assets and uses the
// AD_*_TREASURY recipients.
//
// A payment is valid when a single finalized transaction, signed by the
// advertiser's connected wallet (`payer`):
//   1. succeeded (meta.err === null),
//   2. for SPL assets, uses the legacy SPL Token program (not Token-2022),
//   3. carries a memo exactly equal to the quoteId (binds tx ⇄ quote ⇄ advertiser),
//   4. credited the asset treasury at least `priceBase`, and
//   5. (defense in depth) debited the payer at least `priceBase`.
//
// IMPORTANT — deferred $WOC burn: at payment time 100% of a $WOC ad purchase goes
// to the treasury (fully refundable). The configured WOC_AD_BURN_BPS is burned
// only AFTER admin approval (see ad_refund.ts), so a rejected booking refunds in
// full. Hence the $WOC path here checks a treasury credit, NOT a burn.
//
// The handler layer (ads.ts /confirm) adds the tx_sig replay guard (ad_payments
// tx_sig UNIQUE). `creditedBase` is the treasury credit and equals the refundable
// amount recorded as ad_payments.treasury_base.
import {
  getFinalizedTx,
  txSucceeded,
  usesToken2022,
  ownerSpentBase,
  ownerCreditedBase,
  lamportsCreditedTo,
  lamportsSpentBy,
} from './solana_tx';
import { hasMemo } from './solana_tx';
import { type AdAsset, adMint, adTreasury } from './woc_config';

const BASE58 = /^[1-9A-HJ-NP-Za-km-z]{32,90}$/;

export interface AdPaymentResult {
  ok: boolean;
  reason?: string;
  spentBase: bigint; // what the payer paid out (token base units / lamports)
  creditedBase: bigint; // what landed in the treasury — the refundable amount
}

const fail = (reason: string): AdPaymentResult => ({ ok: false, reason, spentBase: 0n, creditedBase: 0n });

/**
 * Verify that `signature` is a finalized payment of at least `priceBase` (base
 * units of `asset`) by `payer` into the asset treasury, tagged with `memo`.
 * Returns ok=false with a reason for any failure ('not_finalized' is retryable).
 */
export async function verifyAdPayment(
  asset: AdAsset,
  signature: string,
  payer: string,
  priceBase: bigint,
  memo: string,
): Promise<AdPaymentResult> {
  if (!BASE58.test(signature)) return fail('bad_signature');
  if (priceBase <= 0n) return fail('bad_price');
  const treasury = adTreasury(asset);
  if (!treasury) return fail('treasury_unset');

  const tx = await getFinalizedTx(signature);
  if (!tx) return fail('not_finalized');
  if (!txSucceeded(tx)) return fail('tx_failed');
  if (!hasMemo(tx, memo)) return fail('memo_mismatch');

  if (asset === 'SOL') {
    // Native SOL. Reject payer == treasury so a self/round-trip transfer (which
    // nets the treasury to zero anyway) can never spoof a credit.
    if (payer === treasury) return fail('self_transfer');
    const creditedBase = lamportsCreditedTo(tx, treasury);
    if (creditedBase < priceBase) return fail('treasury_short');
    const spentBase = lamportsSpentBy(tx, payer); // fee rides on top, not inside
    if (spentBase < priceBase) return fail('underpaid');
    return { ok: true, spentBase, creditedBase };
  }

  // SPL assets (USDC, WOC). The treasury credit is the load-bearing proof; a
  // self-transfer nets the payer to zero and credits nobody.
  const mint = adMint(asset);
  if (!mint) return fail('bad_asset');
  if (usesToken2022(tx, mint)) return fail('token_2022');
  const creditedBase = ownerCreditedBase(tx, treasury, mint);
  if (creditedBase < priceBase) return fail('treasury_short');
  const spentBase = ownerSpentBase(tx, payer, mint);
  if (spentBase < priceBase) return fail('underpaid');
  return { ok: true, spentBase, creditedBase };
}
