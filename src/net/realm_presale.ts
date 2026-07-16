// Client-side builder for a realm token presale contribution (launchpad phase
// 2). A contribution is ONE transaction paying the quoted amount into the
// founder escrow wallet, tagged with the quoteId memo so the server can bind
// the finalized transaction to its quote (server/realm_presale.ts verifies the
// escrow's balance delta). Pure (no wallet/network), mirroring
// src/net/realm_buy.ts, whose instruction builders it reuses; the wallet send
// wrapper is signAndSendPresaleContribution in src/net/wallet.ts.

import type { PublicKey, TransactionInstruction } from '@solana/web3.js';
import { createAtaIdempotentIx, memoIx, nativeTransferIx, transferCheckedIx } from './realm_buy';
import { ownerTokenAccount } from './realm_escrow';

export interface PresaleContributionPlan {
  contributor: PublicKey;
  native: boolean; // SOL (System transfer) vs SPL (USDC / $WOC TransferChecked)
  currencyMint: PublicKey; // the SPL mint (ignored when native)
  currencyDecimals: number;
  escrow: PublicKey; // the founder escrow wallet (owner pubkey)
  amountBase: bigint;
  memo: string; // the quoteId
}

// Build the contribution instructions: a single leg into the escrow plus the
// binding memo. SPL rails create the escrow's ATA idempotently first (the
// contributor funds the rent), exactly like the buy path's recipient legs.
export function buildPresaleContributionInstructions(
  plan: PresaleContributionPlan,
): TransactionInstruction[] {
  const ixs: TransactionInstruction[] = [];
  if (plan.native) {
    ixs.push(nativeTransferIx(plan.contributor, plan.escrow, plan.amountBase));
  } else {
    const from = ownerTokenAccount(plan.contributor, plan.currencyMint);
    const to = ownerTokenAccount(plan.escrow, plan.currencyMint);
    ixs.push(createAtaIdempotentIx(plan.contributor, plan.escrow, plan.currencyMint));
    ixs.push(
      transferCheckedIx(
        from,
        plan.currencyMint,
        to,
        plan.contributor,
        plan.amountBase,
        plan.currencyDecimals,
      ),
    );
  }
  ixs.push(memoIx(plan.memo));
  return ixs;
}
