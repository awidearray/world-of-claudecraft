// Ad keeper: refunds rejected bookings and executes the deferred $WOC burn on
// approval. Modeled on server/buyback.ts (the only other server-side hot wallet).
//
// Custody model: AD_REFUND_KEEPER_SECRET controls the AD_*_TREASURY addresses
// (recommended: treasury == keeper), so collected ad revenue *is* the refundable
// float — a refund can never exceed what was collected for that booking. The
// keeper is flag-gated (AD_REFUND_ENABLED) and refuses to run without a secret.
//
// Refund flow (admin reject): markRefundPending row-CAS is the cross-process lock
// (only one process refunds a given booking); the refund amount is treasury_base −
// burned_base (what the treasury still holds for it); ad_refunds.refund_sig +
// booking_id UNIQUE give on-chain idempotency. A failed send leaves the booking
// 'refund_failed' (retryable).
//
// Deferred burn (admin approve): a WOC booking credited the treasury 100% at pay
// time; on approval we burn WOC_AD_BURN_BPS of the price from the treasury, so a
// rejected (never-approved) booking always refunds in full.
import {
  Connection, Keypair, PublicKey, Transaction, TransactionInstruction, SystemProgram,
} from '@solana/web3.js';
import {
  getAssociatedTokenAddressSync,
  createTransferCheckedInstruction,
  createAssociatedTokenAccountIdempotentInstruction,
  createBurnCheckedInstruction,
} from '@solana/spl-token';
import bs58 from 'bs58';
import {
  SOLANA_RPC_URL,
  WOC_MINT,
  WOC_DECIMALS,
  AD_REFUND_ENABLED,
  AD_REFUND_KEEPER_SECRET,
  adDecimals,
  adMint,
  splitAdPrice,
  type AdAsset,
} from './woc_config';
import {
  markRefundPending,
  revertRefundPending,
  getAdPaymentForBooking,
  recordAdRefund,
  setBookingRefunded,
  setBookingState,
  existingRefundSig,
  claimAdBurn,
  revertAdBurnClaim,
  recordDeferredBurn,
} from './ads_db';

const MEMO_PROGRAM_ID = new PublicKey('MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr');
const SOL_FEE_BUFFER = 10_000n; // lamports headroom for tx fee on a SOL refund

let _connection: Connection | null = null;
function connection(): Connection {
  if (!_connection) _connection = new Connection(SOLANA_RPC_URL, 'confirmed');
  return _connection;
}

let _keeper: Keypair | null = null;
function keeperWallet(): Keypair {
  if (_keeper) return _keeper;
  if (!AD_REFUND_KEEPER_SECRET) throw new Error('AD_REFUND_KEEPER_SECRET is not set');
  _keeper = Keypair.fromSecretKey(bs58.decode(AD_REFUND_KEEPER_SECRET));
  return _keeper;
}

/** True once the keeper can run (flag on + secret configured). */
export function refundReady(): boolean {
  return AD_REFUND_ENABLED && AD_REFUND_KEEPER_SECRET.length > 0;
}

function memoIx(text: string): TransactionInstruction {
  return new TransactionInstruction({ programId: MEMO_PROGRAM_ID, keys: [], data: Buffer.from(text, 'utf8') });
}

async function sendSigned(tx: Transaction): Promise<string> {
  const keeper = keeperWallet();
  const { blockhash, lastValidBlockHeight } = await connection().getLatestBlockhash('confirmed');
  tx.feePayer = keeper.publicKey;
  tx.recentBlockhash = blockhash;
  tx.lastValidBlockHeight = lastValidBlockHeight;
  tx.sign(keeper);
  const sig = await connection().sendRawTransaction(tx.serialize());
  await connection().confirmTransaction({ signature: sig, blockhash, lastValidBlockHeight }, 'confirmed');
  return sig;
}

// Keeper's available balance of `asset` in base units (lamports for SOL).
async function keeperBalanceBase(asset: AdAsset): Promise<bigint> {
  const keeper = keeperWallet();
  if (asset === 'SOL') return BigInt(await connection().getBalance(keeper.publicKey, 'confirmed'));
  const ata = getAssociatedTokenAddressSync(new PublicKey(adMint(asset)!), keeper.publicKey);
  const info = await connection().getTokenAccountBalance(ata, 'confirmed');
  return BigInt(info.value.amount);
}

export type RefundResult =
  | { status: 'refunded'; refundSig: string; amountBase: string }
  | { status: 'already_refunded'; refundSig: string }
  | { status: 'not_refundable' }
  | { status: 'insufficient_treasury' }
  | { status: 'disabled' }
  | { status: 'failed'; error: string };

/**
 * Refund a booking to its payer. Idempotent + cross-process safe via the
 * markRefundPending CAS and the UNIQUE refund ledger. The amount is what the
 * treasury still holds for the booking (treasury_base − burned_base).
 */
export async function refundAdBooking(bookingId: number): Promise<RefundResult> {
  if (!refundReady()) return { status: 'disabled' };

  // Cross-process claim. If we don't win, it's already refunded (return its sig)
  // or not in a refundable state.
  const claim = await markRefundPending(bookingId);
  if (!claim) {
    const sig = await existingRefundSig(bookingId);
    return sig ? { status: 'already_refunded', refundSig: sig } : { status: 'not_refundable' };
  }

  try {
    const payment = await getAdPaymentForBooking(bookingId);
    if (!payment) {
      await revertRefundPending(bookingId, 'pending_review');
      return { status: 'not_refundable' };
    }
    const asset = payment.asset;
    const refundBase = BigInt(payment.treasury_base) - BigInt(payment.burned_base);
    const payer = payment.payer_pubkey;

    // Nothing left to refund (e.g. a fully-burned, post-approval booking). Close
    // it out without an on-chain send.
    if (refundBase <= 0n) {
      await setBookingRefunded(bookingId, 'burned-no-refund');
      return { status: 'refunded', refundSig: 'burned-no-refund', amountBase: '0' };
    }

    // Pre-flight: never strand the booking in refund_pending if the treasury is
    // short — revert it to a refundable state and report.
    const have = await keeperBalanceBase(asset);
    const need = asset === 'SOL' ? refundBase + SOL_FEE_BUFFER : refundBase;
    if (have < need) {
      await revertRefundPending(bookingId, 'pending_review');
      return { status: 'insufficient_treasury' };
    }

    const keeper = keeperWallet();
    const payerKey = new PublicKey(payer);
    const tx = new Transaction();
    if (asset === 'SOL') {
      tx.add(SystemProgram.transfer({ fromPubkey: keeper.publicKey, toPubkey: payerKey, lamports: refundBase }));
    } else {
      const mint = new PublicKey(adMint(asset)!);
      const fromAta = getAssociatedTokenAddressSync(mint, keeper.publicKey);
      const toAta = getAssociatedTokenAddressSync(mint, payerKey);
      tx.add(createAssociatedTokenAccountIdempotentInstruction(keeper.publicKey, toAta, payerKey, mint));
      tx.add(createTransferCheckedInstruction(fromAta, mint, toAta, keeper.publicKey, refundBase, adDecimals(asset)));
    }
    tx.add(memoIx(`refund:${bookingId}`));
    const refundSig = await sendSigned(tx);

    const rec = await recordAdRefund({ bookingId, adPaymentId: payment.id, asset, amountBase: refundBase, refundSig, payerPubkey: payer });
    // A duplicate (booking_id/refund_sig UNIQUE) means a racing refund already
    // landed — treat as idempotent success.
    await setBookingRefunded(bookingId, refundSig);
    if (!rec) {
      const existing = await existingRefundSig(bookingId);
      return { status: 'already_refunded', refundSig: existing ?? refundSig };
    }
    return { status: 'refunded', refundSig, amountBase: refundBase.toString() };
  } catch (err) {
    // Leave the booking retryable; the next admin reject / sweeper can re-attempt.
    await setBookingState(bookingId, 'refund_failed').catch(() => {});
    console.error(`[ads] refund of booking ${bookingId} failed:`, err);
    return { status: 'failed', error: err instanceof Error ? err.message : 'refund failed' };
  }
}

export type BurnResult =
  | { status: 'burned'; burnSig: string; burnedBase: string }
  | { status: 'nothing' }
  | { status: 'disabled' }
  | { status: 'failed'; error: string };

/**
 * Execute the deferred $WOC burn for a just-approved WOC booking: burn
 * WOC_AD_BURN_BPS of the locked price from the treasury. Idempotent via the
 * claimAdBurn sentinel. Best-effort — a failure does not unwind the approval; the
 * burn can be retried. No-op for non-WOC assets or when the burn split is 0.
 */
export async function burnApprovedAdWoc(bookingId: number): Promise<BurnResult> {
  if (!refundReady()) return { status: 'disabled' };
  const claim = await claimAdBurn(bookingId); // WOC + not-yet-burned only
  if (!claim) return { status: 'nothing' };
  try {
    const payment = await getAdPaymentForBooking(bookingId);
    if (!payment) {
      await revertAdBurnClaim(bookingId);
      return { status: 'nothing' };
    }
    const { burnBase } = splitAdPrice(BigInt(payment.treasury_base));
    if (burnBase <= 0n) {
      await revertAdBurnClaim(bookingId);
      return { status: 'nothing' };
    }
    const keeper = keeperWallet();
    const mint = new PublicKey(WOC_MINT);
    const ata = getAssociatedTokenAddressSync(mint, keeper.publicKey);
    const tx = new Transaction();
    tx.add(createBurnCheckedInstruction(ata, mint, keeper.publicKey, burnBase, WOC_DECIMALS));
    tx.add(memoIx(`adburn:${bookingId}`));
    const burnSig = await sendSigned(tx);
    await recordDeferredBurn(bookingId, payment.id, burnSig, burnBase);
    return { status: 'burned', burnSig, burnedBase: burnBase.toString() };
  } catch (err) {
    await revertAdBurnClaim(bookingId).catch(() => {});
    console.error(`[ads] deferred burn for booking ${bookingId} failed:`, err);
    return { status: 'failed', error: err instanceof Error ? err.message : 'burn failed' };
  }
}
