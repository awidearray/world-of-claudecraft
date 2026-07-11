// Launchpad panel view-core + error-mapping coverage: the pure vote/presale
// render math (realm_launchpad_view.ts) against both server-shaped payloads,
// the exact amount parser/formatter, the checklist resolver, and the
// launchpad ERR_KEYS table's coverage of every server-emitted code.

import { describe, expect, it } from 'vitest';
import { ApiError } from '../src/net/online';
import { t } from '../src/ui/i18n';
import { ERR_KEYS, messageForError, STATUS_KEYS } from '../src/ui/realm_launchpad';
import {
  bpsPercent,
  curveView,
  formatBaseAmount,
  type LaunchWire,
  launchpadChecklist,
  launchView,
  type PresaleWire,
  parseAmountToBase,
  presaleView,
  type VoteWire,
  voteView,
} from '../src/ui/realm_launchpad_view';

function vote(over: Partial<VoteWire> = {}): VoteWire {
  return {
    status: 'voting',
    yesWeight: '600000',
    noWeight: '400000',
    voteCount: 2,
    quorumWoc: '2000000',
    yesThresholdBps: 6000,
    outcome: 'pending',
    myChoice: null,
    myWeightWoc: null,
    ...over,
  };
}

describe('voteView', () => {
  it('computes the yes share and quorum progress exactly', () => {
    const v = voteView(vote());
    expect(v.yesSharePct).toBe(60);
    expect(v.quorumPct).toBe(50); // 1M of 2M quorum
    expect(v.thresholdPct).toBe(60);
    expect(v.canVote).toBe(true);
  });

  it('caps quorum at 100 and closes voting once a choice is recorded', () => {
    const v = voteView(vote({ quorumWoc: '500000', myChoice: 'yes', myWeightWoc: '123' }));
    expect(v.quorumPct).toBe(100);
    expect(v.canVote).toBe(false);
    expect(v.myWeight).toBe(123n);
  });

  it('handles the empty tally and a closed window', () => {
    const empty = voteView(vote({ yesWeight: '0', noWeight: '0', voteCount: 0 }));
    expect(empty.yesSharePct).toBe(0);
    expect(empty.quorumPct).toBe(0);
    const closed = voteView(vote({ status: 'presale', outcome: 'passed' }));
    expect(closed.canVote).toBe(false);
  });

  it('is exact on whale-scale weights (no float in the math)', () => {
    const v = voteView(vote({ yesWeight: '9007199254740993', noWeight: '9007199254740993' }));
    expect(v.yesSharePct).toBe(50);
    expect(v.totalWeight).toBe(18014398509481986n);
  });
});

function presale(over: Partial<PresaleWire> = {}): PresaleWire {
  return {
    configured: true,
    status: 'presale',
    escrowWallet: 'So11111111111111111111111111111111111111112',
    progressBps: 4000,
    softCapMet: false,
    rails: [
      {
        currency: 'SOL',
        mint: '',
        decimals: 9,
        native: true,
        softCapBase: '1000000000',
        raiseCapBase: '2000000000',
        walletCapBase: '500000000',
        raisedBase: '400000000',
        myContributedBase: '100000000',
        myRemainingBase: '400000000',
      },
    ],
    refund: null,
    ...over,
  };
}

describe('presaleView', () => {
  it('maps progress bps to a percent and rails to exact bigints', () => {
    const p = presaleView(presale());
    expect(p.progressPct).toBe(40);
    expect(p.open).toBe(true);
    expect(p.rails[0]).toMatchObject({
      currency: 'SOL',
      raisedBase: 400000000n,
      railPct: 40,
      contributable: true,
    });
  });

  it('closes contributions off-presale and when the wallet has no headroom', () => {
    const funded = presaleView(presale({ status: 'funded' }));
    expect(funded.open).toBe(false);
    expect(funded.rails[0].contributable).toBe(false);
    const full = presale();
    full.rails[0].myRemainingBase = '0';
    expect(presaleView(full).rails[0].contributable).toBe(false);
  });

  it('surfaces the refund state', () => {
    const p = presaleView(presale({ status: 'refunding', refund: { unrefundedCount: 3 } }));
    expect(p.refunding).toBe(true);
    expect(p.unrefundedCount).toBe(3);
  });
});

describe('launchpadChecklist', () => {
  it('walks register -> vote -> presale -> launch', () => {
    expect(launchpadChecklist('none').map((s) => s.current)).toEqual([true, false, false, false]);
    expect(launchpadChecklist('voting').map((s) => s.done)).toEqual([true, false, false, false]);
    expect(launchpadChecklist('presale').map((s) => s.done)).toEqual([true, true, false, false]);
    expect(launchpadChecklist('funded').map((s) => s.done)).toEqual([true, true, true, false]);
    expect(launchpadChecklist('live').every((s) => s.done)).toBe(true);
    // A refunding presale sits back on the presale step (not past it).
    expect(launchpadChecklist('refunding').map((s) => s.current)).toEqual([
      false,
      false,
      true,
      false,
    ]);
  });
});

describe('parseAmountToBase / formatBaseAmount (exact bigint round-trip)', () => {
  it('parses whole and fractional amounts exactly', () => {
    expect(parseAmountToBase('1', 9)).toBe(1_000_000_000n);
    expect(parseAmountToBase('1.5', 9)).toBe(1_500_000_000n);
    expect(parseAmountToBase('0.000000001', 9)).toBe(1n);
    expect(parseAmountToBase('123.456789', 6)).toBe(123_456_789n);
  });

  it('rejects malformed, zero, negative, and over-precise input', () => {
    expect(parseAmountToBase('', 9)).toBeNull();
    expect(parseAmountToBase('0', 9)).toBeNull();
    expect(parseAmountToBase('-1', 9)).toBeNull();
    expect(parseAmountToBase('1.1234567', 6)).toBeNull(); // 7 fraction digits on a 6dp mint
    expect(parseAmountToBase('1e9', 9)).toBeNull();
    expect(parseAmountToBase('1,5', 9)).toBeNull();
  });

  it('formats base amounts trimming trailing zeros', () => {
    expect(formatBaseAmount(1_500_000_000n, 9)).toBe('1.5');
    expect(formatBaseAmount(2_000_000n, 6)).toBe('2');
    expect(formatBaseAmount(1n, 9)).toBe('0.000000001');
    expect(formatBaseAmount(0n, 6)).toBe('0');
  });

  it('round-trips parse -> format', () => {
    for (const s of ['1', '1.5', '0.25', '1234.000001']) {
      const base = parseAmountToBase(s, 6);
      expect(base).not.toBeNull();
      expect(parseAmountToBase(formatBaseAmount(base!, 6), 6)).toBe(base);
    }
  });
});

function launchWire(over: Partial<LaunchWire> = {}): LaunchWire {
  return {
    prepared: true,
    mint: null,
    pendingMint: 'PendingMint111111111111111111111111111111',
    supplyBase: '1000000000000000000',
    alloc: {
      publicBps: 6000,
      liquidityBps: 1000,
      founderBps: 1200,
      levyBps: 800,
      treasuryBps: 1000,
    },
    split: {
      publicBase: '600000000000000000',
      liquidityBase: '100000000000000000',
      founderBase: '120000000000000000',
      levyBase: '80000000000000000',
      treasuryBase: '100000000000000000',
    },
    lockTerms: [
      {
        bucket: 'founder',
        recipient: 'Founder111',
        amountBase: '120000000000000000',
        cliffMonths: 12,
        linearMonths: 36,
        frequencySeconds: '2629746',
        cliffUnlockAmount: '0',
        amountPerPeriod: '3333333333333333',
        numberOfPeriod: '36',
      },
      {
        bucket: 'levy',
        recipient: 'Levy111',
        amountBase: '80000000000000000',
        cliffMonths: 12,
        linearMonths: 48,
        frequencySeconds: '2629746',
        cliffUnlockAmount: '0',
        amountPerPeriod: '1666666666666666',
        numberOfPeriod: '48',
      },
      {
        bucket: 'treasury',
        recipient: 'Treasury111',
        amountBase: '100000000000000000',
        cliffMonths: 6,
        linearMonths: 24,
        frequencySeconds: '2629746',
        cliffUnlockAmount: '0',
        amountPerPeriod: '4166666666666666',
        numberOfPeriod: '24',
      },
    ],
    lockAddresses: { founder: null, levy: null, treasury: null },
    mintConfirmed: false,
    locksVerified: false,
    ...over,
  };
}

describe('launchView', () => {
  it('maps the pinned economics into bucket rows', () => {
    const v = launchView(launchWire(), 'funded');
    expect(v.supplyBase).toBe(1_000_000_000_000_000_000n);
    expect(v.publicBps).toBe(6000);
    expect(v.buckets.map((b) => b.bucket)).toEqual(['founder', 'levy', 'treasury']);
    expect(v.buckets[0].shareBps).toBe(1200);
    expect(v.buckets[1].cliffMonths).toBe(12);
    expect(v.buckets[1].linearMonths).toBe(48);
    expect(v.buckets[2].amountBase).toBe(100_000_000_000_000_000n);
  });

  it('walks the step ladder: mint -> locks -> list -> live', () => {
    const fresh = launchView(launchWire(), 'funded');
    expect(fresh.steps.find((s) => s.current)?.step).toBe('mint');
    expect(fresh.needsLockAddresses).toBe(false);

    const minted = launchView(launchWire({ mint: 'M', mintConfirmed: true }), 'funded');
    expect(minted.steps.find((s) => s.current)?.step).toBe('locks');
    expect(minted.needsLockAddresses).toBe(true);

    const verified = launchView(
      launchWire({ mint: 'M', mintConfirmed: true, locksVerified: true }),
      'funded',
    );
    expect(verified.steps.find((s) => s.current)?.step).toBe('list');
    expect(verified.steps.filter((s) => s.done).map((s) => s.step)).toEqual([
      'mint',
      'locks',
      'verify',
    ]);
    expect(verified.needsLockAddresses).toBe(false);

    const live = launchView(
      launchWire({ mint: 'M', mintConfirmed: true, locksVerified: true }),
      'live',
    );
    expect(live.steps.every((s) => s.done)).toBe(true);
  });

  it('surfaces pinned lock addresses on their buckets', () => {
    const v = launchView(
      launchWire({
        mint: 'M',
        mintConfirmed: true,
        lockAddresses: { founder: 'FL', levy: 'LL', treasury: 'TL' },
      }),
      'funded',
    );
    expect(v.buckets.map((b) => b.lockAddress)).toEqual(['FL', 'LL', 'TL']);
  });

  it('tolerates an unprepared launch (all-null wire)', () => {
    const v = launchView(
      launchWire({
        prepared: false,
        supplyBase: null,
        alloc: null,
        split: null,
        lockTerms: null,
        lockAddresses: null,
        pendingMint: null,
      }),
      'funded',
    );
    expect(v.prepared).toBe(false);
    expect(v.supplyBase).toBeNull();
    expect(v.buckets).toEqual([]);
  });
});

describe('curveView', () => {
  const wire = {
    host: 'meteora-dbc' as const,
    config: {
      quoteMint: '',
      migrationQuoteThresholdBase: '100000000000',
      partnerLockedLpBps: 6000,
      creatorLockedLpBps: 4000,
    },
    curve: {
      poolAddress: 'Pool111',
      quoteReserveBase: '25000000000',
      progressBps: 2500,
      migrated: false,
    },
    graduated: false,
    poolAddress: null,
    lpLockAddress: null,
  };

  it('maps the live curve state to the render model', () => {
    const v = curveView(wire);
    expect(v.created).toBe(true);
    expect(v.progressPct).toBe(25);
    expect(v.raisedBase).toBe(25_000_000_000n);
    expect(v.thresholdBase).toBe(100_000_000_000n);
    expect(v.quoteDecimals).toBe(9); // native SOL quote
    expect(v.lockedLpBps).toBe(10_000);
    expect(v.migrated).toBe(false);
  });

  it('handles the not-yet-created and graduated shapes', () => {
    const bare = curveView({ ...wire, curve: null, config: null });
    expect(bare.created).toBe(false);
    expect(bare.progressPct).toBe(0);
    expect(bare.thresholdBase).toBe(0n);

    const grad = curveView({ ...wire, graduated: true, poolAddress: 'Damm111' });
    expect(grad.graduated).toBe(true);
    expect(grad.dammPoolAddress).toBe('Damm111');
  });

  it('displays SPL quote assets at 6 decimals', () => {
    const usdc = curveView({
      ...wire,
      config: { ...wire.config, quoteMint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v' },
    });
    expect(usdc.quoteDecimals).toBe(6);
  });
});

describe('bpsPercent', () => {
  it('renders whole and fractional percents exactly', () => {
    expect(bpsPercent(6000)).toBe('60');
    expect(bpsPercent(1250)).toBe('12.5');
    expect(bpsPercent(1234)).toBe('12.34');
    expect(bpsPercent(5)).toBe('0.05');
    expect(bpsPercent(0)).toBe('0');
  });
});

describe('ERR_KEYS server-code coverage', () => {
  // Every typed `error` code the launchpad routes can put on the wire
  // (server/realm_token.ts, realm_vote.ts, realm_presale.ts + the route-level
  // literals in server/main.ts). A new code without a mapping renders generic.
  const SERVER_CODES = [
    // register
    'not_realm_owner',
    'realm_not_found',
    'realm_not_active',
    'invalid_token_symbol',
    'invalid_token_icon',
    'invalid_token_policy',
    'token_already_registered',
    // vote
    'token_not_registered',
    'vote_not_open',
    'vote_not_openable',
    'invalid_vote_choice',
    'wallet_not_linked',
    'vote_weight_unavailable',
    'no_vote_weight',
    'already_voted',
    // presale config + quote
    'presale_not_open',
    'presale_not_configured',
    'presale_already_configured',
    'presale_unavailable',
    'invalid_escrow_wallet',
    'invalid_presale_caps',
    'invalid_currency',
    'currency_not_enabled',
    'invalid_amount',
    'wallet_cap_exceeded',
    'raise_cap_exceeded',
    // presale confirm + verifier verdicts
    'quote_not_found',
    'not_your_quote',
    'quote_expired',
    'contribution_already_recorded',
    'bad_signature',
    'not_finalized',
    'tx_failed',
    'token_2022',
    'memo_mismatch',
    'wrong_payer',
    'escrow_short',
    'missing_quoteId_or_paySig',
    // refund path
    'presale_not_refunding',
    'contribution_not_found',
    'already_refunded',
    'refund_sig_reused',
    'wrong_refunder',
    'refund_short',
    'missing_payTxSig_or_refundSig',
    // launch (phase 3): mint factory + lock verification
    'mint_already_created',
    'presale_not_funded',
    'levy_fund_unconfigured',
    'invalid_treasury_wallet',
    'invalid_token_name',
    'invalid_token_uri',
    'chain_unavailable',
    'launch_not_prepared',
    'mint_not_in_tx',
    'mint_not_found',
    'wrong_token_program',
    'wrong_decimals',
    'freeze_authority_set',
    'bad_metadata_pointer',
    'metadata_symbol_mismatch',
    'unexpected_extension',
    'launch_sig_replayed',
    'mint_not_created',
    'invalid_lock_address',
    'launch_not_verifiable',
    'locks_not_verified',
    'not_listable',
    'missing_sig',
    // curve (phase 4): bonding-curve listing + graduation
    'launchpad_disabled',
    'launchpad_config_unreadable',
    'curve_already_created',
    'host_requires_dbc_mint',
    'invalid_base_mint',
    'curve_not_found',
    'wrong_curve_creator',
    'not_live',
    'not_migrated',
    'graduation_not_found',
    'lp_not_permanently_locked',
    'not_damm_v2',
    'no_locked_vesting',
    'no_migration_threshold',
    // power (phase 7, server/realm_power.ts): token-to-copper conversion.
    // Only the codes NEW to this phase are listed; the quote/confirm path also
    // reuses codes already pinned above (quote_not_found, wrong_payer, ...).
    'power_disabled',
    'realm_not_power',
    'token_not_live',
    'power_rate_unset',
    'power_sink_unavailable',
    'amount_below_minimum',
    'character_not_found',
    'sink_short',
    'credit_already_recorded',
    // route-level rate limit literal
    'too many requests, slow down',
  ];

  it('maps every server-emitted code', () => {
    const missing = SERVER_CODES.filter((c) => !(c in ERR_KEYS));
    expect(missing).toEqual([]);
  });

  it('every mapping resolves to a non-empty launchpad.err.* string', () => {
    for (const key of Object.values(ERR_KEYS)) {
      expect(key.startsWith('launchpad.err.')).toBe(true);
      expect(t(key).length).toBeGreaterThan(0);
    }
  });

  it('messageForError maps codes, the wallet sentinel, and unknowns', () => {
    expect(messageForError(new ApiError('already_voted', 409))).toBe(
      t('launchpad.err.already_voted'),
    );
    expect(messageForError(new ApiError('mystery_code', 500))).toBe(t('launchpad.err.generic'));
    expect(messageForError(new Error('wallet_mismatch'))).toBe(t('launchpad.err.wallet_mismatch'));
    expect(messageForError(new Error('User rejected the request.'))).toBe(
      'User rejected the request.',
    );
    expect(messageForError(undefined)).toBe(t('launchpad.err.generic'));
  });

  it('every token lifecycle status has a badge key that resolves', () => {
    for (const status of [
      'none',
      'prelaunch',
      'voting',
      'presale',
      'funded',
      'refunding',
      'refunded',
      'live',
      'graduated',
      'closed',
    ]) {
      const key = STATUS_KEYS[status];
      expect(key, `status ${status}`).toBeDefined();
      expect(t(key).length).toBeGreaterThan(0);
    }
  });
});
