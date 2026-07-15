// Launchpad phase 7 (in-world currency re-skin): the currency identity on BOTH
// worlds (offline Sim always classic; online ClientWorld from the hello),
// the sim staying opaque-copper (no chain concept leaks in), and the
// power-realm token-to-copper credit (the monetization_policy gate, the flag
// gate, the exact conversion, the verify rejections, and the ledger replay
// guard).

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PowerCreditDeps, PowerCreditStore } from '../server/realm_power_credit';
import { creditTokenToCopper, tokenBaseToCopper } from '../server/realm_power_credit';
import type {
  MonetizationPolicy,
  RealmToken,
  RealmTokenDb,
  RealmTokenStatus,
} from '../server/realm_token';
import { fetchFinalizedTransaction, type RawConfirmedTransaction } from '../server/solana_rpc';
import { TOKEN_2022_PROGRAM } from '../server/solana_token2022';
import { ClientWorld } from '../src/net/online';
import { Sim } from '../src/sim/sim';
import { CLASSIC_CURRENCY } from '../src/world_api';

vi.mock('../server/solana_rpc', async (importActual) => {
  const actual = await importActual<typeof import('../server/solana_rpc')>();
  return { ...actual, fetchFinalizedTransaction: vi.fn() };
});

// ── The currency identity on both worlds ──────────────────────────────────────

describe('currencyIdentity on both worlds', () => {
  it('the offline Sim always uses the classic coin display', () => {
    const sim = new Sim({ seed: 1, playerClass: 'warrior', playerName: 'A' });
    expect(sim.currencyIdentity).toEqual(CLASSIC_CURRENCY);
    expect(sim.currencyIdentity.realmToken).toBe(false);
  });

  // A bare ClientWorld (Object.create skips the socket-opening constructor);
  // the hello handler is exercised directly, like tests/snapshots.test.ts. The
  // private onMessage is reached through a structural cast.
  interface BareClient {
    currencyIdentity: typeof CLASSIC_CURRENCY;
    onMessage(raw: string): void;
  }
  function bareClient(): BareClient {
    const w = Object.create(ClientWorld.prototype) as Record<string, unknown>;
    w.cfg = { seed: 20061, playerClass: 'warrior' };
    w.entities = new Map();
    w.currencyIdentity = CLASSIC_CURRENCY; // the constructor field initializer default
    w.reconnectAttempts = 0;
    w.profanityWords = [];
    return w as unknown as BareClient;
  }

  it('ClientWorld re-skins from a hello carrying a realm token identity', () => {
    const cw = bareClient();
    cw.onMessage(
      JSON.stringify({
        t: 'hello',
        pid: 1,
        seed: 5,
        realm: 'Moonrealm',
        currency: { symbol: 'MOON', icon: 'moon', realmToken: true },
      }),
    );
    expect(cw.currencyIdentity).toEqual({ symbol: 'MOON', icon: 'moon', realmToken: true });
  });

  it('ClientWorld keeps the classic display for a malformed hello currency', () => {
    const cw = bareClient();
    cw.onMessage(
      JSON.stringify({ t: 'hello', pid: 1, seed: 5, realm: 'R', currency: { symbol: 123 } }),
    );
    expect(cw.currencyIdentity).toEqual(CLASSIC_CURRENCY);
  });

  it('ClientWorld leaves the default when hello carries no currency', () => {
    const cw = bareClient();
    cw.onMessage(JSON.stringify({ t: 'hello', pid: 1, seed: 5, realm: 'R' }));
    expect(cw.currencyIdentity).toEqual(CLASSIC_CURRENCY);
  });
});

// ── The power-realm token-to-copper credit ────────────────────────────────────

describe('tokenBaseToCopper (exact conversion)', () => {
  it('floors the division and clamps past the safe integer range', () => {
    expect(tokenBaseToCopper(1_000_000n, 1_000_000n)).toBe(1);
    expect(tokenBaseToCopper(2_500_000n, 1_000_000n)).toBe(2); // floor
    expect(tokenBaseToCopper(999_999n, 1_000_000n)).toBe(0);
    expect(tokenBaseToCopper(0n, 1_000_000n)).toBe(0);
    expect(tokenBaseToCopper(10n ** 30n, 1n)).toBe(Number.MAX_SAFE_INTEGER);
  });
});

const FOUNDER = '11111111111111111111111111111111';
const SINK = 'So11111111111111111111111111111111111111112';
const MINT = 'MoonMint111111111111111111111111111111111111';
const OTHER = 'Other11111111111111111111111111111111111111';
const SIG = '5'.repeat(80);

function token(over: Partial<RealmToken> = {}): RealmToken {
  return {
    realmId: 7,
    mint: MINT,
    decimals: 9,
    symbol: 'MOON',
    icon: '',
    status: 'live',
    monetizationPolicy: 'power',
    curveAddress: null,
    poolAddress: null,
    lpLockAddress: null,
    feeClaimerPda: null,
    launchTxSig: null,
    distributeTxSig: null,
    supplyBase: null,
    founderAllocBase: null,
    levyAllocBase: null,
    treasuryAllocBase: null,
    founderLockAddress: null,
    levyLockAddress: null,
    treasuryLockAddress: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...over,
  };
}

class FakeTokens implements RealmTokenDb {
  row: RealmToken | null = token();
  async getRealmToken() {
    return this.row;
  }
  async insertRealmToken(): Promise<RealmToken> {
    throw new Error('unused');
  }
  async listRealmTokens() {
    return new Map<number, RealmToken>();
  }
  async setRealmTokenStatus(_r: number, _f: readonly RealmTokenStatus[], _t: RealmTokenStatus) {
    return null;
  }
  async recordMintCreated() {
    return null;
  }
  async recordDistribution() {
    return null;
  }
  async recordLockAddress() {
    return null;
  }
  async recordCurveLaunch() {
    return null;
  }
  async recordLpLock() {
    return null;
  }
  async listByStatus(): Promise<Array<RealmToken & { realmName: string }>> {
    return [];
  }
}

class FakeStore implements PowerCreditStore {
  seen = new Set<string>();
  async recordCredit(c: { payTxSig: string }) {
    if (this.seen.has(c.payTxSig)) return false;
    this.seen.add(c.payTxSig);
    return true;
  }
}

function moveTx(opts: {
  feePayer?: string;
  sinkDelta?: bigint;
  err?: unknown;
  foreignProgram?: boolean;
}): RawConfirmedTransaction {
  const post =
    opts.sinkDelta !== undefined
      ? [
          {
            owner: SINK,
            mint: MINT,
            programId: opts.foreignProgram
              ? 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA'
              : TOKEN_2022_PROGRAM,
            uiTokenAmount: { amount: opts.sinkDelta.toString() },
          },
        ]
      : [];
  return {
    meta: { err: opts.err ?? null, preTokenBalances: [], postTokenBalances: post },
    transaction: { message: { accountKeys: [opts.feePayer ?? FOUNDER, OTHER], instructions: [] } },
  };
}

function makeDeps(over: Partial<PowerCreditDeps> = {}): PowerCreditDeps & {
  tokens: FakeTokens;
  store: FakeStore;
  credited: number[];
} {
  const tokens = new FakeTokens();
  const store = new FakeStore();
  const credited: number[] = [];
  return {
    tokens,
    store,
    credited,
    walletForAccount: async () => ({ pubkey: FOUNDER }),
    creditCopperToAccount: async (_acc: number, copper: number) => {
      credited.push(copper);
      return true;
    },
    ...over,
  } as PowerCreditDeps & { tokens: FakeTokens; store: FakeStore; credited: number[] };
}

describe('creditTokenToCopper', () => {
  beforeEach(() => {
    process.env.REALM_POWER_CREDIT_ENABLED = '1';
    process.env.REALM_POWER_SINK_WALLET = SINK;
    process.env.REALM_POWER_TOKEN_PER_COPPER = '1000000';
  });
  afterEach(() => {
    delete process.env.REALM_POWER_CREDIT_ENABLED;
    delete process.env.REALM_POWER_SINK_WALLET;
    delete process.env.REALM_POWER_TOKEN_PER_COPPER;
    vi.mocked(fetchFinalizedTransaction).mockReset();
  });

  it('credits copper for a verified transfer into the power sink, exactly once', async () => {
    const deps = makeDeps();
    vi.mocked(fetchFinalizedTransaction).mockResolvedValue(
      moveTx({ sinkDelta: 5_000_000n }), // 5 tokens -> 5 copper
    );
    const result = await creditTokenToCopper(deps, { accountId: 1, realmId: 7, payTxSig: SIG });
    expect(result).toMatchObject({ ok: true, copper: 5 });
    expect(deps.credited).toEqual([5]);
    // Replay: the same signature is rejected by the ledger UNIQUE guard.
    vi.mocked(fetchFinalizedTransaction).mockResolvedValue(moveTx({ sinkDelta: 5_000_000n }));
    expect(
      await creditTokenToCopper(deps, { accountId: 1, realmId: 7, payTxSig: SIG }),
    ).toMatchObject({ ok: false, error: 'credit_already_recorded' });
    expect(deps.credited).toEqual([5]); // not credited twice
  });

  it('the monetization_policy gate: a cosmetic realm can never convert to power', async () => {
    const deps = makeDeps();
    deps.tokens.row = token({ monetizationPolicy: 'cosmetic' });
    vi.mocked(fetchFinalizedTransaction).mockResolvedValue(moveTx({ sinkDelta: 5_000_000n }));
    expect(
      await creditTokenToCopper(deps, { accountId: 1, realmId: 7, payTxSig: SIG }),
    ).toMatchObject({ ok: false, error: 'not_power_realm' });
    expect(deps.credited).toEqual([]);
  });

  it('the flag gate: the whole path is disabled by default', async () => {
    delete process.env.REALM_POWER_CREDIT_ENABLED;
    const deps = makeDeps();
    expect(
      await creditTokenToCopper(deps, { accountId: 1, realmId: 7, payTxSig: SIG }),
    ).toMatchObject({ ok: false, error: 'power_credit_disabled' });
  });

  it('rejects wrong payer, no sink credit, a foreign program, a reverted tx, and a bad sig', async () => {
    const deps = makeDeps();
    vi.mocked(fetchFinalizedTransaction).mockResolvedValue(
      moveTx({ feePayer: OTHER, sinkDelta: 5_000_000n }),
    );
    expect(
      await creditTokenToCopper(deps, { accountId: 1, realmId: 7, payTxSig: SIG }),
    ).toMatchObject({
      ok: false,
      error: 'wrong_payer',
    });
    vi.mocked(fetchFinalizedTransaction).mockResolvedValue(moveTx({})); // no sink delta
    expect(
      await creditTokenToCopper(deps, { accountId: 1, realmId: 7, payTxSig: SIG }),
    ).toMatchObject({
      ok: false,
      error: 'sink_not_credited',
    });
    vi.mocked(fetchFinalizedTransaction).mockResolvedValue(
      moveTx({ sinkDelta: 5_000_000n, foreignProgram: true }),
    );
    expect(
      await creditTokenToCopper(deps, { accountId: 1, realmId: 7, payTxSig: SIG }),
    ).toMatchObject({
      ok: false,
      error: 'token_2022_mismatch',
    });
    vi.mocked(fetchFinalizedTransaction).mockResolvedValue(
      moveTx({ sinkDelta: 5_000_000n, err: { x: 1 } }),
    );
    expect(
      await creditTokenToCopper(deps, { accountId: 1, realmId: 7, payTxSig: SIG }),
    ).toMatchObject({
      ok: false,
      error: 'tx_failed',
    });
    expect(
      await creditTokenToCopper(deps, { accountId: 1, realmId: 7, payTxSig: 'l1O0' }),
    ).toMatchObject({
      ok: false,
      error: 'bad_signature',
    });
  });

  it('rejects a sub-copper transfer', async () => {
    const deps = makeDeps();
    vi.mocked(fetchFinalizedTransaction).mockResolvedValue(moveTx({ sinkDelta: 500_000n })); // < 1 copper
    expect(
      await creditTokenToCopper(deps, { accountId: 1, realmId: 7, payTxSig: SIG }),
    ).toMatchObject({
      ok: false,
      error: 'amount_too_small',
    });
  });
});
