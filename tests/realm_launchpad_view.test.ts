// Launchpad panel view-core + error-mapping coverage: the pure vote/presale
// render math (realm_launchpad_view.ts) against both server-shaped payloads,
// the exact amount parser/formatter, the checklist resolver, and the
// launchpad ERR_KEYS table's coverage of every server-emitted code.

import { describe, expect, it } from 'vitest';
import { ApiError } from '../src/net/online';
import { t } from '../src/ui/i18n';
import { ERR_KEYS, messageForError, STATUS_KEYS } from '../src/ui/realm_launchpad';
import {
  formatBaseAmount,
  launchpadChecklist,
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
    // phase 3 launch flow (server/realm_token_mint.ts + the route literal)
    'mint_not_ready',
    'token_already_minted',
    'token_not_minted',
    'levy_wallet_unconfigured',
    'launch_unavailable',
    'launch_sig_reused',
    'mint_mismatch',
    'already_distributed',
    'not_distributed',
    'distribution_mismatch',
    'invalid_lock_bucket',
    'already_locked',
    'lock_mismatch',
    'lock_not_immutable',
    'lock_underfunded',
    'locks_incomplete',
    'missing_quoteId_or_signature',
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
