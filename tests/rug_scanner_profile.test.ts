// Launchpad phase 8: the RugCheck / Birdeye clean-score ACCEPTANCE TEST (PRD
// sections 7 and 11). Scanners buyers actually run flag a fixed set of rug
// vectors; this suite maps each scanner line item onto the invariant the
// server ENFORCES (not promises) and proves the enforcement by mutation: the
// canonical launch profile scores clean end-to-end through the real
// verifiers, and re-introducing any single red flag fails the specific check.
//
// Scanner line items covered:
//   1. Mint authority retained          -> verifyLaunch mint_authority_renounced
//   2. Freeze authority set             -> mintProfileIssues freeze_authority_set
//   3. Transfer fee / hook / permanent
//      delegate / pausable extension    -> mintProfileIssues unexpected_extension
//   4. Mutable metadata                 -> mintProfileIssues bad_metadata_pointer
//   5. Supply mismatch / hidden mint    -> verifyLaunch supply_exact
//   6. Cancelable / re-targetable vest  -> verifyLaunch <bucket>_lock_immutable
//   7. Unfunded lock (fake vesting)     -> verifyLaunch <bucket>_lock_funded
//   8. Backdated cliff (instant unlock) -> verifyLaunch <bucket>_lock_schedule
//   9. LP not permanently locked        -> configGuaranteeIssues lp_not_permanently_locked
//  10. No real migration (perma-curve)  -> configGuaranteeIssues no_migration_threshold
//  11. Insider-heavy allocation         -> resolveAllocationBps caps + public floor

import { Keypair } from '@solana/web3.js';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { LaunchpadPartnerConfig } from '../server/realm_launchpad';
import { configGuaranteeIssues } from '../server/realm_launchpad';
import type {
  MonetizationPolicy,
  RealmToken,
  RealmTokenDb,
  RealmTokenStatus,
} from '../server/realm_token';
import {
  type AllocationBps,
  MONTH_SECONDS,
  PUBLIC_BPS_FLOOR,
  realmTokenSupplyBase,
  resolveAllocationBps,
  splitSupplyBase,
  vestingScheduleFor,
} from '../server/realm_token_alloc';
import {
  confirmMintCreate,
  type LaunchChainReader,
  type MintDeps,
  mintProfileIssues,
  prepareMintCreate,
  type RealmTokenLaunch,
  type RealmTokenLaunchStore,
  verifyLaunch,
} from '../server/realm_token_mint';
import type { RawConfirmedTransaction } from '../server/solana_rpc';
import { SPL_TOKEN_2022_PROGRAM } from '../server/solana_rpc';
import type { Token2022MintState, VestingEscrowState } from '../server/token2022_verify';
import { LOCK_MODE_NEITHER, LOCK_TOKEN_PROGRAM_2022 } from '../server/token2022_verify';

// ── Fixture (the clean launch profile) ───────────────────────────────────────

const FOUNDER = Keypair.generate().publicKey.toBase58();
const LEVY = Keypair.generate().publicKey.toBase58();
const TREASURY = Keypair.generate().publicKey.toBase58();
const FOUNDER_LOCK = Keypair.generate().publicKey.toBase58();
const LEVY_LOCK = Keypair.generate().publicKey.toBase58();
const TREASURY_LOCK = Keypair.generate().publicKey.toBase58();
const BLOCKHASH = Keypair.generate().publicKey.toBase58();
const SIG = '5'.repeat(64);
const REALM = 7;
const ACCOUNT = 1;
const LOCK_ARGS = {
  accountId: ACCOUNT,
  realmId: REALM,
  founderLock: FOUNDER_LOCK,
  levyLock: LEVY_LOCK,
  treasuryLock: TREASURY_LOCK,
};

class UniqueViolation extends Error {}

// The platform-fund wallet the prepare gate requires (fail-closed without it).
beforeEach(() => {
  process.env.LEVY_FUND_WALLET = LEVY;
});
afterEach(() => {
  delete process.env.LEVY_FUND_WALLET;
});

function tokenRow(realmId: number): RealmToken {
  return {
    realmId,
    mint: null,
    decimals: 9,
    symbol: 'MOON',
    icon: '',
    status: 'funded' as RealmTokenStatus,
    monetizationPolicy: 'cosmetic' as MonetizationPolicy,
    curveAddress: null,
    poolAddress: null,
    lpLockAddress: null,
    feeClaimerPda: null,
    launchTxSig: null,
    createdAt: new Date('2026-07-01T00:00:00Z'),
    updatedAt: new Date('2026-07-01T00:00:00Z'),
  };
}

class FakeTokenDb implements RealmTokenDb {
  rows = new Map<number, RealmToken>();
  usedSigs = new Set<string>();
  async getRealmToken(realmId: number): Promise<RealmToken | null> {
    return this.rows.get(realmId) ?? null;
  }
  async insertRealmToken(t: {
    realmId: number;
    symbol: string;
    icon: string;
    monetizationPolicy: MonetizationPolicy;
  }): Promise<RealmToken> {
    const row = { ...tokenRow(t.realmId), symbol: t.symbol, icon: t.icon };
    this.rows.set(t.realmId, row);
    return row;
  }
  async listRealmTokens(realmIds: number[]): Promise<Map<number, RealmToken>> {
    const out = new Map<number, RealmToken>();
    for (const id of realmIds) {
      const row = this.rows.get(id);
      if (row) out.set(id, row);
    }
    return out;
  }
  async setRealmTokenStatus(
    realmId: number,
    from: readonly RealmTokenStatus[],
    to: RealmTokenStatus,
  ): Promise<RealmToken | null> {
    const row = this.rows.get(realmId);
    if (!row || !from.includes(row.status)) return null;
    const next = { ...row, status: to };
    this.rows.set(realmId, next);
    return next;
  }
}

class FakeLaunchStore implements RealmTokenLaunchStore {
  rows = new Map<number, RealmTokenLaunch>();
  constructor(private tokens: FakeTokenDb) {}
  async getLaunch(realmId: number): Promise<RealmTokenLaunch | null> {
    return this.rows.get(realmId) ?? null;
  }
  async upsertPendingLaunch(l: {
    realmId: number;
    pendingMint: string;
    supplyBase: bigint;
    alloc: AllocationBps;
    founderWallet: string;
    levyWallet: string;
    treasuryWallet: string;
  }): Promise<boolean> {
    const existing = this.rows.get(l.realmId);
    if (existing?.mintConfirmedAt) return false;
    this.rows.set(l.realmId, {
      ...l,
      founderLockAddress: null,
      levyLockAddress: null,
      treasuryLockAddress: null,
      mintConfirmedAt: null,
      locksVerifiedAt: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    return true;
  }
  async recordMintCreated(realmId: number, mint: string, sig: string): Promise<boolean> {
    if (this.tokens.usedSigs.has(sig)) throw new UniqueViolation('launch_tx_sig');
    const token = this.tokens.rows.get(realmId);
    const launch = this.rows.get(realmId);
    if (!token || token.mint !== null || !launch || launch.pendingMint !== mint) return false;
    this.tokens.usedSigs.add(sig);
    this.tokens.rows.set(realmId, { ...token, mint, launchTxSig: sig });
    this.rows.set(realmId, { ...launch, mintConfirmedAt: new Date(), updatedAt: new Date() });
    return true;
  }
  async setLockAddresses(
    realmId: number,
    locks: { founder: string; levy: string; treasury: string },
  ): Promise<boolean> {
    const launch = this.rows.get(realmId);
    if (!launch || launch.mintConfirmedAt === null || launch.locksVerifiedAt !== null) return false;
    this.rows.set(realmId, {
      ...launch,
      founderLockAddress: locks.founder,
      levyLockAddress: locks.levy,
      treasuryLockAddress: locks.treasury,
      updatedAt: new Date(),
    });
    return true;
  }
  async markLocksVerified(realmId: number): Promise<boolean> {
    const launch = this.rows.get(realmId);
    if (!launch || launch.mintConfirmedAt === null || launch.locksVerifiedAt !== null) return false;
    this.rows.set(realmId, { ...launch, locksVerifiedAt: new Date(), updatedAt: new Date() });
    return true;
  }
}

class FakeChain implements LaunchChainReader {
  txs = new Map<string, RawConfirmedTransaction>();
  mints = new Map<string, Token2022MintState>();
  escrows = new Map<string, VestingEscrowState>();
  balances = new Map<string, bigint>();
  async fetchTx(sig: string): Promise<RawConfirmedTransaction | null> {
    return this.txs.get(sig) ?? null;
  }
  async fetchMintState(mint: string): Promise<Token2022MintState | null> {
    return this.mints.get(mint) ?? null;
  }
  async fetchVestingEscrow(address: string): Promise<VestingEscrowState | null> {
    return this.escrows.get(address) ?? null;
  }
  async fetchOwnedBalance(mint: string, owner: string): Promise<bigint | null> {
    return this.balances.get(`${mint}:${owner}`) ?? null;
  }
  async latestBlockhash(): Promise<string | null> {
    return BLOCKHASH;
  }
  async minRentLamports(_space: number): Promise<bigint | null> {
    return 5_000_000n;
  }
}

interface Harness {
  deps: MintDeps;
  tokens: FakeTokenDb;
  launches: FakeLaunchStore;
  chain: FakeChain;
}

function harness(): Harness {
  const tokens = new FakeTokenDb();
  const launches = new FakeLaunchStore(tokens);
  const chain = new FakeChain();
  const deps: MintDeps = {
    tokens,
    launches,
    chain,
    walletForAccount: async () => ({ pubkey: FOUNDER }),
    rolesForAccountOnRealm: async () => ['owner'],
    isUniqueViolation: (err: unknown) => err instanceof UniqueViolation,
  };
  return { deps, tokens, launches, chain };
}

function goodMintState(mint: string, over: Partial<Token2022MintState> = {}): Token2022MintState {
  return {
    ownerProgram: SPL_TOKEN_2022_PROGRAM,
    decimals: 9,
    supply: 0n,
    mintAuthority: FOUNDER,
    freezeAuthority: null,
    metadataPointer: { authority: null, metadataAddress: mint },
    tokenMetadata: { name: 'MOON', symbol: 'MOON', uri: '', updateAuthority: FOUNDER },
    extraExtensions: [],
    ...over,
  };
}

// The canonical clean launch: mint created via the real prepare/confirm flow,
// then the fully consistent post-distribution chain (exact supply, renounced
// authority, three immutable funded escrows on the pinned schedules).
async function cleanLaunch(): Promise<{ h: Harness; mint: string }> {
  const h = harness();
  h.tokens.rows.set(REALM, tokenRow(REALM));
  const prep = await prepareMintCreate(h.deps, {
    accountId: ACCOUNT,
    realmId: REALM,
    treasuryWallet: TREASURY,
  });
  if (!prep.ok) throw new Error(`prepare failed: ${prep.error}`);
  const mint = prep.mint;
  h.chain.txs.set(SIG, {
    meta: { err: null },
    transaction: {
      message: { accountKeys: [{ pubkey: FOUNDER }, { pubkey: mint }], instructions: [] },
    },
  });
  h.chain.mints.set(mint, goodMintState(mint));
  const confirm = await confirmMintCreate(h.deps, { accountId: ACCOUNT, realmId: REALM, sig: SIG });
  if (!confirm.ok) throw new Error(`confirm failed: ${confirm.error}`);

  const supply = realmTokenSupplyBase();
  const split = splitSupplyBase(supply, resolveAllocationBps({}));
  h.chain.mints.set(mint, goodMintState(mint, { supply, mintAuthority: null }));
  const now = BigInt(Math.floor(Date.now() / 1000));
  const escrow = (
    bucket: 'founder' | 'levy' | 'treasury',
    recipient: string,
    amount: bigint,
  ): VestingEscrowState => {
    const s = vestingScheduleFor(bucket, amount);
    return {
      recipient,
      tokenMint: mint,
      creator: FOUNDER,
      escrowBump: 254,
      updateRecipientMode: LOCK_MODE_NEITHER,
      cancelMode: LOCK_MODE_NEITHER,
      tokenProgramFlag: LOCK_TOKEN_PROGRAM_2022,
      cliffTime: now + BigInt(s.cliffMonths) * MONTH_SECONDS,
      frequency: s.frequency,
      cliffUnlockAmount: s.cliffUnlockAmount,
      amountPerPeriod: s.amountPerPeriod,
      numberOfPeriod: s.numberOfPeriod,
      totalClaimedAmount: 0n,
      vestingStartTime: now,
      cancelledAt: 0n,
    };
  };
  h.chain.escrows.set(FOUNDER_LOCK, escrow('founder', FOUNDER, split.founderBase));
  h.chain.escrows.set(LEVY_LOCK, escrow('levy', LEVY, split.levyBase));
  h.chain.escrows.set(TREASURY_LOCK, escrow('treasury', TREASURY, split.treasuryBase));
  h.chain.balances.set(`${mint}:${FOUNDER_LOCK}`, split.founderBase);
  h.chain.balances.set(`${mint}:${LEVY_LOCK}`, split.levyBase);
  h.chain.balances.set(`${mint}:${TREASURY_LOCK}`, split.treasuryBase);
  return { h, mint };
}

async function verify(h: Harness) {
  const res = await verifyLaunch(h.deps, LOCK_ARGS);
  if (!res.ok) throw new Error(`verify failed outright: ${res.error}`);
  return res;
}

function failedChecks(res: { checks: Array<{ check: string; ok: boolean }> }): string[] {
  return res.checks.filter((c) => !c.ok).map((c) => c.check);
}

// ── The acceptance: the canonical profile scores clean ───────────────────────

describe('clean score: the canonical launch profile', () => {
  it('passes EVERY scanner-relevant on-chain check', async () => {
    const { h } = await cleanLaunch();
    const res = await verify(h);
    expect(res.verified).toBe(true);
    expect(failedChecks(res)).toEqual([]);
  });

  it('the mint itself carries the boring metadata-only profile', async () => {
    const { h, mint } = await cleanLaunch();
    const state = h.chain.mints.get(mint);
    if (!state) throw new Error('mint state missing');
    expect(mintProfileIssues(state, { mint, symbol: 'MOON' })).toEqual([]);
    // The two authorities scanners check first.
    expect(state.mintAuthority).toBeNull();
    expect(state.freezeAuthority).toBeNull();
  });
});

// ── Mutations: each scanner red flag fails its specific check ────────────────

describe('scanner red flags fail verification by mutation', () => {
  it('1. retained mint authority', async () => {
    const { h, mint } = await cleanLaunch();
    const state = h.chain.mints.get(mint);
    if (!state) throw new Error('mint state missing');
    h.chain.mints.set(mint, { ...state, mintAuthority: FOUNDER });
    const res = await verify(h);
    expect(res.verified).toBe(false);
    expect(failedChecks(res)).toContain('mint_authority_renounced');
  });

  it('2. freeze authority set', () => {
    const state = goodMintState('MintX', { freezeAuthority: FOUNDER });
    expect(mintProfileIssues(state, { mint: 'MintX', symbol: 'MOON' })).toContain(
      'freeze_authority_set',
    );
  });

  it('3. transfer fee, transfer hook, permanent delegate, or pausable extension', () => {
    for (const extension of [
      'transferFeeConfig',
      'transferHook',
      'permanentDelegate',
      'pausableConfig',
    ]) {
      const state = goodMintState('MintX', { extraExtensions: [extension] });
      expect(mintProfileIssues(state, { mint: 'MintX', symbol: 'MOON' }), extension).toContain(
        'unexpected_extension',
      );
    }
  });

  it('4. mutable metadata pointer', () => {
    const state = goodMintState('MintX', {
      metadataPointer: { authority: FOUNDER, metadataAddress: 'MintX' },
    });
    expect(mintProfileIssues(state, { mint: 'MintX', symbol: 'MOON' })).toContain(
      'bad_metadata_pointer',
    );
  });

  it('5. supply mismatch (hidden inflation)', async () => {
    const { h, mint } = await cleanLaunch();
    const state = h.chain.mints.get(mint);
    if (!state) throw new Error('mint state missing');
    h.chain.mints.set(mint, { ...state, supply: state.supply + 1n });
    const res = await verify(h);
    expect(res.verified).toBe(false);
    expect(failedChecks(res)).toContain('supply_exact');
  });

  it('6. cancelable or re-targetable founder vesting', async () => {
    for (const mutation of [{ cancelMode: 1 }, { updateRecipientMode: 1 }]) {
      const { h } = await cleanLaunch();
      const escrow = h.chain.escrows.get(FOUNDER_LOCK);
      if (!escrow) throw new Error('escrow missing');
      h.chain.escrows.set(FOUNDER_LOCK, { ...escrow, ...mutation });
      const res = await verify(h);
      expect(res.verified, JSON.stringify(mutation)).toBe(false);
      expect(failedChecks(res)).toContain('founder_lock_immutable');
    }
  });

  it('7. unfunded lock (vesting theater)', async () => {
    const { h, mint } = await cleanLaunch();
    h.chain.balances.set(`${mint}:${LEVY_LOCK}`, 0n);
    const res = await verify(h);
    expect(res.verified).toBe(false);
    expect(failedChecks(res)).toContain('levy_lock_funded');
  });

  it('8. backdated cliff (instant-unlock vesting)', async () => {
    const { h } = await cleanLaunch();
    const escrow = h.chain.escrows.get(FOUNDER_LOCK);
    if (!escrow) throw new Error('escrow missing');
    // Cliff already in the past: the schedule floor check catches it even
    // though the escrow is otherwise well-formed.
    h.chain.escrows.set(FOUNDER_LOCK, {
      ...escrow,
      cliffTime: BigInt(Math.floor(Date.now() / 1000)) - 60n,
    });
    const res = await verify(h);
    expect(res.verified).toBe(false);
    expect(failedChecks(res)).toContain('founder_lock_schedule');
  });
});

// ── LP lock + migration guarantees (the curve-side scanner checks) ───────────

function cleanConfig(over: Partial<LaunchpadPartnerConfig> = {}): LaunchpadPartnerConfig {
  return {
    configAddress: 'Config111',
    quoteMint: '',
    feeClaimer: 'FeeClaimer111',
    migrationQuoteThresholdBase: 100_000_000_000n,
    migrationOption: 1,
    tokenType: 1,
    partnerLockedLpBps: 5_000,
    creatorLockedLpBps: 5_000,
    lockedVestingPresent: true,
    ...over,
  };
}

describe('curve-side guarantees (LP lock + graduation)', () => {
  it('the pinned config profile carries every guarantee', () => {
    expect(configGuaranteeIssues(cleanConfig(), 10_000)).toEqual([]);
  });

  it('9. LP not permanently locked in full', () => {
    expect(configGuaranteeIssues(cleanConfig({ partnerLockedLpBps: 4_000 }), 10_000)).toContain(
      'lp_not_permanently_locked',
    );
  });

  it('10. no real migration threshold, or graduation to an unlockable pool', () => {
    expect(
      configGuaranteeIssues(cleanConfig({ migrationQuoteThresholdBase: 0n }), 10_000),
    ).toContain('no_migration_threshold');
    expect(configGuaranteeIssues(cleanConfig({ migrationOption: 0 }), 10_000)).toContain(
      'not_damm_v2',
    );
    expect(configGuaranteeIssues(cleanConfig({ lockedVestingPresent: false }), 10_000)).toContain(
      'no_locked_vesting',
    );
  });
});

// ── Allocation floors (insider-heavy distributions cannot be configured) ─────

describe('11. insider allocation caps hold by construction', () => {
  it('the default split keeps the public share at or above the floor', () => {
    const alloc = resolveAllocationBps({});
    expect(alloc.publicBps).toBeGreaterThanOrEqual(PUBLIC_BPS_FLOOR);
  });

  it('maxed-out env knobs still cannot push the public share under the floor', () => {
    const alloc = resolveAllocationBps({
      REALM_TOKEN_ALLOC_FOUNDER_BPS: '9999',
      REALM_TOKEN_ALLOC_LEVY_BPS: '9999',
      REALM_TOKEN_ALLOC_TREASURY_BPS: '9999',
      REALM_TOKEN_ALLOC_LIQUIDITY_BPS: '9999',
    });
    expect(alloc.publicBps).toBeGreaterThanOrEqual(PUBLIC_BPS_FLOOR);
    // And the split still sums exactly.
    const split = splitSupplyBase(realmTokenSupplyBase(), alloc);
    expect(
      split.publicBase +
        split.liquidityBase +
        split.founderBase +
        split.levyBase +
        split.treasuryBase,
    ).toBe(realmTokenSupplyBase());
  });
});
