// Verifies server/ad_payment.ts (multi-asset ad payment check) and the native-SOL
// lamport-delta primitives added to server/solana_tx.ts. Only the RPC fetch
// (getFinalizedTx) is mocked; the balance-delta math, lamport math, memo and
// Token-2022 detection all run for real against synthetic finalized-tx fixtures.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  SPL_TOKEN_PROGRAM,
  TOKEN_2022_PROGRAM,
  lamportsDeltaFor,
  lamportsCreditedTo,
  lamportsSpentBy,
  type FinalizedTx,
} from '../server/solana_tx';

const USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const WOC_MINT = '3WjLscH2JsXLEFJZRA9z8ti8yRGxWGKbqymPd7UicRth';
const PAYER = 'Payer1111111111111111111111111111111111111';
const USDC_TREASURY = 'UsdcTreasury11111111111111111111111111111';
const SOL_TREASURY = 'SolTreasury111111111111111111111111111111';
const WOC_TREASURY = 'WocTreasury111111111111111111111111111111';
const SIG = '5'.repeat(80);

// Keep the real solana_tx helpers; only stub the RPC fetch.
vi.mock('../server/solana_tx', async (importActual) => {
  const actual = await importActual<typeof import('../server/solana_tx')>();
  return { ...actual, getFinalizedTx: vi.fn() };
});
// Deterministic treasuries + mints so the test never depends on env.
vi.mock('../server/woc_config', () => ({
  adTreasury: (asset: string) => (asset === 'USDC' ? USDC_TREASURY : asset === 'SOL' ? SOL_TREASURY : WOC_TREASURY),
  adMint: (asset: string) => (asset === 'USDC' ? USDC_MINT : asset === 'WOC' ? WOC_MINT : null),
  SOLANA_RPC_URL: 'http://localhost',
}));

import { getFinalizedTx } from '../server/solana_tx';
import { verifyAdPayment } from '../server/ad_payment';

const mocked = vi.mocked(getFinalizedTx);
beforeEach(() => mocked.mockReset());

function base(): FinalizedTx {
  return {
    signature: SIG, err: null, preTokenBalances: [], postTokenBalances: [], instructions: [],
    accountKeys: [], preBalances: [], postBalances: [], feeLamports: 0n,
  };
}
function memoIx(memo: string) {
  return { program: 'spl-memo', parsed: memo };
}
// SPL transfer: payer pre->post and treasury pre->post on the given mint.
function tokenFixture(mint: string, treasury: string, opts: { payerPre?: string; payerPost?: string; treasPre?: string; treasPost?: string; memo?: string | null; programId?: string } = {}): FinalizedTx {
  const programId = opts.programId ?? SPL_TOKEN_PROGRAM;
  const tx = base();
  tx.preTokenBalances = [
    { owner: PAYER, mint, programId, uiTokenAmount: { amount: opts.payerPre ?? '1000', decimals: 6 } },
    { owner: treasury, mint, programId, uiTokenAmount: { amount: opts.treasPre ?? '0', decimals: 6 } },
  ];
  tx.postTokenBalances = [
    { owner: PAYER, mint, programId, uiTokenAmount: { amount: opts.payerPost ?? '500', decimals: 6 } },
    { owner: treasury, mint, programId, uiTokenAmount: { amount: opts.treasPost ?? '500', decimals: 6 } },
  ];
  if (opts.memo !== null) tx.instructions = [memoIx(opts.memo ?? 'quote-abc')];
  return tx;
}
// Native SOL transfer payer -> treasury (lamports), fee charged to payer on top.
function solFixture(opts: { payerPre?: bigint; amount?: bigint; fee?: bigint; treasuryKey?: string; memo?: string | null } = {}): FinalizedTx {
  const amount = opts.amount ?? 1_000_000n;
  const fee = opts.fee ?? 5000n;
  const payerPre = opts.payerPre ?? 10_000_000n;
  const treasuryKey = opts.treasuryKey ?? SOL_TREASURY;
  const tx = base();
  tx.accountKeys = [PAYER, treasuryKey];
  tx.preBalances = [payerPre, 0n];
  tx.postBalances = [payerPre - amount - fee, amount];
  tx.feeLamports = fee;
  if (opts.memo !== null) tx.instructions = [memoIx(opts.memo ?? 'quote-abc')];
  return tx;
}

describe('lamport helpers', () => {
  it('computes net credit and spend from balance deltas', () => {
    const tx = solFixture({ amount: 1_000_000n, fee: 5000n });
    expect(lamportsCreditedTo(tx, SOL_TREASURY)).toBe(1_000_000n);
    expect(lamportsSpentBy(tx, PAYER)).toBe(1_005_000n); // amount + fee
    expect(lamportsDeltaFor(tx, PAYER)).toBe(-1_005_000n);
  });
  it('a self-transfer nets ~zero at the treasury (only fee leaves)', () => {
    const tx = base();
    tx.accountKeys = [PAYER];
    tx.preBalances = [10_000_000n];
    tx.postBalances = [10_000_000n - 5000n]; // round-trip; only fee gone
    expect(lamportsCreditedTo(tx, PAYER)).toBe(0n);
  });
});

describe('verifyAdPayment — USDC', () => {
  it('accepts a finalized transfer crediting the treasury, matching memo', async () => {
    mocked.mockResolvedValue(tokenFixture(USDC_MINT, USDC_TREASURY, { memo: 'quote-abc' }));
    const r = await verifyAdPayment('USDC', SIG, PAYER, 500n, 'quote-abc');
    expect(r.ok).toBe(true);
    expect(r.creditedBase).toBe(500n);
    expect(r.spentBase).toBe(500n);
  });
  it('rejects when the treasury is short-changed', async () => {
    mocked.mockResolvedValue(tokenFixture(USDC_MINT, USDC_TREASURY, { treasPost: '300' }));
    const r = await verifyAdPayment('USDC', SIG, PAYER, 500n, 'quote-abc');
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('treasury_short');
  });
  it('rejects a wrong/absent memo', async () => {
    mocked.mockResolvedValue(tokenFixture(USDC_MINT, USDC_TREASURY, { memo: 'someone-else' }));
    expect((await verifyAdPayment('USDC', SIG, PAYER, 500n, 'quote-abc')).reason).toBe('memo_mismatch');
  });
  it('rejects Token-2022 look-alikes', async () => {
    mocked.mockResolvedValue(tokenFixture(USDC_MINT, USDC_TREASURY, { programId: TOKEN_2022_PROGRAM }));
    expect((await verifyAdPayment('USDC', SIG, PAYER, 500n, 'quote-abc')).reason).toBe('token_2022');
  });
});

describe('verifyAdPayment — native SOL', () => {
  it('accepts a finalized transfer crediting the SOL treasury', async () => {
    mocked.mockResolvedValue(solFixture({ amount: 1_000_000n }));
    const r = await verifyAdPayment('SOL', SIG, PAYER, 1_000_000n, 'quote-abc');
    expect(r.ok).toBe(true);
    expect(r.creditedBase).toBe(1_000_000n);
  });
  it('rejects an underfunded treasury credit', async () => {
    mocked.mockResolvedValue(solFixture({ amount: 600_000n }));
    expect((await verifyAdPayment('SOL', SIG, PAYER, 1_000_000n, 'quote-abc')).reason).toBe('treasury_short');
  });
  it('rejects payer == treasury (self-transfer spoof)', async () => {
    // payer is the treasury; even a "credit" is a self move.
    mocked.mockResolvedValue(solFixture({ treasuryKey: SOL_TREASURY }));
    expect((await verifyAdPayment('SOL', SIG, SOL_TREASURY, 1_000_000n, 'quote-abc')).reason).toBe('self_transfer');
  });
});

describe('verifyAdPayment — $WOC (deferred burn: 100% to treasury at pay)', () => {
  it('accepts a transfer crediting the WOC treasury in full, no burn required', async () => {
    mocked.mockResolvedValue(tokenFixture(WOC_MINT, WOC_TREASURY, { memo: 'quote-abc' }));
    const r = await verifyAdPayment('WOC', SIG, PAYER, 500n, 'quote-abc');
    expect(r.ok).toBe(true);
    expect(r.creditedBase).toBe(500n);
  });
});

describe('verifyAdPayment — common guards', () => {
  it('treats a not-yet-finalized tx as retryable', async () => {
    mocked.mockResolvedValue(null);
    expect((await verifyAdPayment('USDC', SIG, PAYER, 500n, 'quote-abc')).reason).toBe('not_finalized');
  });
  it('rejects a failed tx', async () => {
    const tx = tokenFixture(USDC_MINT, USDC_TREASURY);
    tx.err = { InstructionError: [0, 'Custom'] };
    mocked.mockResolvedValue(tx);
    expect((await verifyAdPayment('USDC', SIG, PAYER, 500n, 'quote-abc')).reason).toBe('tx_failed');
  });
});
