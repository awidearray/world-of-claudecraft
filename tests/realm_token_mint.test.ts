// Launchpad phase 3 (server/realm_token_mint.ts): the Token-2022 mint factory
// pipeline against in-memory store + chain fakes. Covers the prepare guards and
// the partial-signed transaction shape (transient mint keypair signs, founder
// pays, boring metadata-only profile), the confirm verification of the
// finalized creation + live mint state with the launch_tx_sig replay guard, the
// full on-chain lock verification (immutability, recipient, exact amounts,
// schedule floors including the backdated-cliff attack, funding), and the
// listing gate: a token physically cannot flip to `live` before its locks are
// verified on-chain and a curve exists.

import { Keypair, Transaction } from '@solana/web3.js';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type {
  MonetizationPolicy,
  RealmToken,
  RealmTokenDb,
  RealmTokenStatus,
} from '../server/realm_token';
import {
  type AllocationBps,
  MONTH_SECONDS,
  realmTokenSupplyBase,
  resolveAllocationBps,
  splitSupplyBase,
  vestingScheduleFor,
} from '../server/realm_token_alloc';
import {
  confirmMintCreate,
  type LaunchChainReader,
  launchReadyToList,
  launchStatus,
  listRealmToken,
  type MintDeps,
  prepareMintCreate,
  type RealmTokenLaunch,
  type RealmTokenLaunchStore,
  verifyLaunch,
} from '../server/realm_token_mint';
import type { RawConfirmedTransaction } from '../server/solana_rpc';
import { SPL_TOKEN_2022_PROGRAM } from '../server/solana_rpc';
import type { Token2022MintState, VestingEscrowState } from '../server/token2022_verify';
import { LOCK_MODE_NEITHER, LOCK_TOKEN_PROGRAM_2022 } from '../server/token2022_verify';

// ── Fixture identities ───────────────────────────────────────────────────────

const FOUNDER = Keypair.generate().publicKey.toBase58();
const LEVY = Keypair.generate().publicKey.toBase58();
const TREASURY = Keypair.generate().publicKey.toBase58();
const FOUNDER_LOCK = Keypair.generate().publicKey.toBase58();
const LEVY_LOCK = Keypair.generate().publicKey.toBase58();
const TREASURY_LOCK = Keypair.generate().publicKey.toBase58();
const BLOCKHASH = Keypair.generate().publicKey.toBase58(); // any 32-byte b58 works
const SIG = '5'.repeat(64);

// ── Fakes ────────────────────────────────────────────────────────────────────

class UniqueViolation extends Error {}
const isFakeUnique = (err: unknown): boolean => err instanceof UniqueViolation;

function tokenRow(realmId: number, over: Partial<RealmToken> = {}): RealmToken {
  return {
    realmId,
    mint: null,
    decimals: 9,
    symbol: 'MOON',
    icon: '',
    status: 'funded',
    monetizationPolicy: 'cosmetic' as MonetizationPolicy,
    curveAddress: null,
    poolAddress: null,
    lpLockAddress: null,
    feeClaimerPda: null,
    launchTxSig: null,
    createdAt: new Date('2026-07-01T00:00:00Z'),
    updatedAt: new Date('2026-07-01T00:00:00Z'),
    ...over,
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
    const row = tokenRow(t.realmId, { symbol: t.symbol, icon: t.icon });
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
      founderLockAddress: existing?.founderLockAddress ?? null,
      levyLockAddress: existing?.levyLockAddress ?? null,
      treasuryLockAddress: existing?.treasuryLockAddress ?? null,
      mintConfirmedAt: null,
      locksVerifiedAt: null,
      createdAt: existing?.createdAt ?? new Date(),
      updatedAt: new Date(),
    });
    return true;
  }
  async recordMintCreated(realmId: number, mint: string, sig: string): Promise<boolean> {
    if (this.usedSig(sig)) throw new UniqueViolation('launch_tx_sig');
    const token = this.tokens.rows.get(realmId);
    const launch = this.rows.get(realmId);
    if (!token || token.mint !== null || !launch || launch.pendingMint !== mint) return false;
    this.tokens.usedSigs.add(sig);
    this.tokens.rows.set(realmId, { ...token, mint, launchTxSig: sig });
    this.rows.set(realmId, { ...launch, mintConfirmedAt: new Date(), updatedAt: new Date() });
    return true;
  }
  private usedSig(sig: string): boolean {
    return this.tokens.usedSigs.has(sig);
  }
  async setLockAddresses(
    realmId: number,
    locks: { founder: string; levy: string; treasury: string },
  ): Promise<boolean> {
    const launch = this.rows.get(realmId);
    if (!launch || launch.mintConfirmedAt === null || launch.locksVerifiedAt !== null) {
      return false;
    }
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
    if (!launch || launch.mintConfirmedAt === null || launch.locksVerifiedAt !== null) {
      return false;
    }
    this.rows.set(realmId, { ...launch, locksVerifiedAt: new Date(), updatedAt: new Date() });
    return true;
  }
}

class FakeChain implements LaunchChainReader {
  txs = new Map<string, RawConfirmedTransaction>();
  mints = new Map<string, Token2022MintState>();
  escrows = new Map<string, VestingEscrowState>();
  balances = new Map<string, bigint>(); // `${mint}:${owner}` -> balance
  blockhash: string | null = BLOCKHASH;
  rent: bigint | null = 5_000_000n;
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
    return this.blockhash;
  }
  async minRentLamports(_space: number): Promise<bigint | null> {
    return this.rent;
  }
}

interface Harness {
  deps: MintDeps;
  tokens: FakeTokenDb;
  launches: FakeLaunchStore;
  chain: FakeChain;
}

function harness(over: { owner?: boolean; wallet?: string | null } = {}): Harness {
  const tokens = new FakeTokenDb();
  const launches = new FakeLaunchStore(tokens);
  const chain = new FakeChain();
  const deps: MintDeps = {
    tokens,
    launches,
    chain,
    walletForAccount: async () =>
      over.wallet === null ? null : { pubkey: over.wallet ?? FOUNDER },
    rolesForAccountOnRealm: async () => (over.owner === false ? ['moderator'] : ['owner']),
    isUniqueViolation: isFakeUnique,
  };
  return { deps, tokens, launches, chain };
}

const REALM = 7;
const ACCOUNT = 1;

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

function creationTx(mint: string, feePayer = FOUNDER): RawConfirmedTransaction {
  return {
    meta: { err: null },
    transaction: {
      message: { accountKeys: [{ pubkey: feePayer }, { pubkey: mint }], instructions: [] },
    },
  };
}

async function preparedHarness(): Promise<{ h: Harness; mint: string }> {
  const h = harness();
  h.tokens.rows.set(REALM, tokenRow(REALM));
  const res = await prepareMintCreate(h.deps, {
    accountId: ACCOUNT,
    realmId: REALM,
    treasuryWallet: TREASURY,
  });
  if (!res.ok) throw new Error(`prepare failed: ${res.error}`);
  return { h, mint: res.mint };
}

async function confirmedHarness(): Promise<{ h: Harness; mint: string }> {
  const { h, mint } = await preparedHarness();
  h.chain.txs.set(SIG, creationTx(mint));
  h.chain.mints.set(mint, goodMintState(mint));
  const res = await confirmMintCreate(h.deps, { accountId: ACCOUNT, realmId: REALM, sig: SIG });
  if (!res.ok) throw new Error(`confirm failed: ${res.error}`);
  return { h, mint };
}

// A fully consistent post-distribution chain: exact supply, renounced
// authority, three immutable funded escrows on the pinned schedules.
function distribute(h: Harness, mint: string): void {
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
}

const LOCK_ARGS = {
  accountId: ACCOUNT,
  realmId: REALM,
  founderLock: FOUNDER_LOCK,
  levyLock: LEVY_LOCK,
  treasuryLock: TREASURY_LOCK,
};

beforeEach(() => {
  process.env.LEVY_FUND_WALLET = LEVY;
});
afterEach(() => {
  delete process.env.LEVY_FUND_WALLET;
});

// ── Prepare ──────────────────────────────────────────────────────────────────

describe('prepareMintCreate', () => {
  it('builds a founder-paid, mint-keypair-partial-signed boring-profile tx', async () => {
    const h = harness();
    h.tokens.rows.set(REALM, tokenRow(REALM));
    const res = await prepareMintCreate(h.deps, {
      accountId: ACCOUNT,
      realmId: REALM,
      treasuryWallet: TREASURY,
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;

    const tx = Transaction.from(Buffer.from(res.txBase64, 'base64'));
    expect(tx.feePayer?.toBase58()).toBe(FOUNDER);
    expect(tx.instructions).toHaveLength(4);
    // The founder's signature slot is open; the transient mint keypair has
    // already signed (it IS the created account).
    const founderSlot = tx.signatures.find((s) => s.publicKey.toBase58() === FOUNDER);
    const mintSlot = tx.signatures.find((s) => s.publicKey.toBase58() === res.mint);
    expect(founderSlot?.signature).toBeNull();
    expect(mintSlot?.signature).not.toBeNull();

    // The launch snapshot is pinned with the exact economics.
    const launch = await h.launches.getLaunch(REALM);
    expect(launch?.pendingMint).toBe(res.mint);
    expect(launch?.supplyBase).toBe(realmTokenSupplyBase());
    expect(launch?.levyWallet).toBe(LEVY);
    expect(launch?.treasuryWallet).toBe(TREASURY);
    expect(res.lockTerms.map((t) => t.bucket)).toEqual(['founder', 'levy', 'treasury']);
    const split = splitSupplyBase(realmTokenSupplyBase(), resolveAllocationBps({}));
    expect(res.lockTerms[0].amountBase).toBe(split.founderBase.toString());
    expect(res.lockTerms[1].recipient).toBe(LEVY);
  });

  it('re-prepare regenerates the mint while unconfirmed', async () => {
    const { h, mint } = await preparedHarness();
    const again = await prepareMintCreate(h.deps, {
      accountId: ACCOUNT,
      realmId: REALM,
      treasuryWallet: TREASURY,
    });
    expect(again.ok).toBe(true);
    if (!again.ok) return;
    expect(again.mint).not.toBe(mint);
    expect((await h.launches.getLaunch(REALM))?.pendingMint).toBe(again.mint);
  });

  it('guards: owner-only, registered, funded, unminted, linked, configured', async () => {
    const notOwner = harness({ owner: false });
    notOwner.tokens.rows.set(REALM, tokenRow(REALM));
    expect(
      await prepareMintCreate(notOwner.deps, {
        accountId: ACCOUNT,
        realmId: REALM,
        treasuryWallet: TREASURY,
      }),
    ).toMatchObject({ ok: false, status: 403, error: 'not_realm_owner' });

    const h = harness();
    expect(
      await prepareMintCreate(h.deps, {
        accountId: ACCOUNT,
        realmId: REALM,
        treasuryWallet: TREASURY,
      }),
    ).toMatchObject({ ok: false, status: 404, error: 'token_not_registered' });

    h.tokens.rows.set(REALM, tokenRow(REALM, { status: 'presale' }));
    expect(
      await prepareMintCreate(h.deps, {
        accountId: ACCOUNT,
        realmId: REALM,
        treasuryWallet: TREASURY,
      }),
    ).toMatchObject({ ok: false, status: 409, error: 'presale_not_funded' });

    h.tokens.rows.set(REALM, tokenRow(REALM, { mint: FOUNDER }));
    expect(
      await prepareMintCreate(h.deps, {
        accountId: ACCOUNT,
        realmId: REALM,
        treasuryWallet: TREASURY,
      }),
    ).toMatchObject({ ok: false, status: 409, error: 'mint_already_created' });

    const unlinked = harness({ wallet: null });
    unlinked.tokens.rows.set(REALM, tokenRow(REALM));
    expect(
      await prepareMintCreate(unlinked.deps, {
        accountId: ACCOUNT,
        realmId: REALM,
        treasuryWallet: TREASURY,
      }),
    ).toMatchObject({ ok: false, status: 400, error: 'wallet_not_linked' });

    delete process.env.LEVY_FUND_WALLET;
    const noLevy = harness();
    noLevy.tokens.rows.set(REALM, tokenRow(REALM));
    expect(
      await prepareMintCreate(noLevy.deps, {
        accountId: ACCOUNT,
        realmId: REALM,
        treasuryWallet: TREASURY,
      }),
    ).toMatchObject({ ok: false, status: 503, error: 'levy_fund_unconfigured' });
    process.env.LEVY_FUND_WALLET = LEVY;

    const badTreasury = harness();
    badTreasury.tokens.rows.set(REALM, tokenRow(REALM));
    expect(
      await prepareMintCreate(badTreasury.deps, {
        accountId: ACCOUNT,
        realmId: REALM,
        treasuryWallet: 'not-an-address',
      }),
    ).toMatchObject({ ok: false, status: 400, error: 'invalid_treasury_wallet' });
  });

  it('validates metadata inputs and requires a reachable chain', async () => {
    const h = harness();
    h.tokens.rows.set(REALM, tokenRow(REALM));
    expect(
      await prepareMintCreate(h.deps, {
        accountId: ACCOUNT,
        realmId: REALM,
        treasuryWallet: TREASURY,
        name: 'x'.repeat(33),
      }),
    ).toMatchObject({ ok: false, status: 400, error: 'invalid_token_name' });
    expect(
      await prepareMintCreate(h.deps, {
        accountId: ACCOUNT,
        realmId: REALM,
        treasuryWallet: TREASURY,
        uri: 'ftp://nope',
      }),
    ).toMatchObject({ ok: false, status: 400, error: 'invalid_token_uri' });

    h.chain.blockhash = null;
    expect(
      await prepareMintCreate(h.deps, {
        accountId: ACCOUNT,
        realmId: REALM,
        treasuryWallet: TREASURY,
      }),
    ).toMatchObject({ ok: false, status: 503, error: 'chain_unavailable' });
  });
});

// ── Confirm ──────────────────────────────────────────────────────────────────

describe('confirmMintCreate', () => {
  it('verifies the finalized creation + live mint state and records the mint', async () => {
    const { h, mint } = await preparedHarness();
    h.chain.txs.set(SIG, creationTx(mint));
    h.chain.mints.set(mint, goodMintState(mint));
    const res = await confirmMintCreate(h.deps, { accountId: ACCOUNT, realmId: REALM, sig: SIG });
    expect(res).toMatchObject({ ok: true, mint });
    const token = await h.tokens.getRealmToken(REALM);
    expect(token?.mint).toBe(mint);
    expect(token?.launchTxSig).toBe(SIG);
    expect((await h.launches.getLaunch(REALM))?.mintConfirmedAt).not.toBeNull();
  });

  it('rejects unverifiable or mismatched creations', async () => {
    const { h, mint } = await preparedHarness();
    const call = (sig = SIG) =>
      confirmMintCreate(h.deps, { accountId: ACCOUNT, realmId: REALM, sig });

    expect(await call('not base58!')).toMatchObject({ ok: false, error: 'bad_signature' });
    expect(await call()).toMatchObject({ ok: false, error: 'not_finalized' });

    h.chain.txs.set(SIG, { ...creationTx(mint), meta: { err: { code: 1 } } });
    expect(await call()).toMatchObject({ ok: false, error: 'tx_failed' });

    h.chain.txs.set(SIG, creationTx(mint, LEVY));
    expect(await call()).toMatchObject({ ok: false, error: 'wrong_payer' });

    h.chain.txs.set(SIG, {
      meta: { err: null },
      transaction: { message: { accountKeys: [{ pubkey: FOUNDER }], instructions: [] } },
    });
    expect(await call()).toMatchObject({ ok: false, error: 'mint_not_in_tx' });

    h.chain.txs.set(SIG, creationTx(mint));
    expect(await call()).toMatchObject({ ok: false, error: 'mint_not_found' });

    const badStates: Array<[Partial<Token2022MintState>, string]> = [
      [{ ownerProgram: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA' }, 'wrong_token_program'],
      [{ decimals: 6 }, 'wrong_decimals'],
      [{ freezeAuthority: FOUNDER }, 'freeze_authority_set'],
      [{ metadataPointer: { authority: FOUNDER, metadataAddress: mint } }, 'bad_metadata_pointer'],
      [{ metadataPointer: { authority: null, metadataAddress: LEVY } }, 'bad_metadata_pointer'],
      [
        { tokenMetadata: { name: 'MOON', symbol: 'RUG', uri: '', updateAuthority: FOUNDER } },
        'metadata_symbol_mismatch',
      ],
      [{ extraExtensions: ['transferFeeConfig'] }, 'unexpected_extension'],
    ];
    for (const [over, error] of badStates) {
      h.chain.mints.set(mint, goodMintState(mint, over));
      expect(await call()).toMatchObject({ ok: false, status: 400, error });
    }
  });

  it('rejects a replayed launch signature and a double confirm', async () => {
    const { h, mint } = await confirmedHarness();
    expect(
      await confirmMintCreate(h.deps, { accountId: ACCOUNT, realmId: REALM, sig: SIG }),
    ).toMatchObject({ ok: false, status: 409, error: 'mint_already_created' });

    // A second realm trying to reuse the same signature hits the UNIQUE guard.
    const REALM2 = 8;
    h.tokens.rows.set(REALM2, tokenRow(REALM2, { symbol: 'MOON2' }));
    const prep = await prepareMintCreate(h.deps, {
      accountId: ACCOUNT,
      realmId: REALM2,
      treasuryWallet: TREASURY,
    });
    expect(prep.ok).toBe(true);
    if (!prep.ok) return;
    h.chain.txs.set(SIG, creationTx(prep.mint));
    h.chain.mints.set(
      prep.mint,
      goodMintState(prep.mint, {
        tokenMetadata: { name: 'MOON2', symbol: 'MOON2', uri: '', updateAuthority: FOUNDER },
      }),
    );
    expect(
      await confirmMintCreate(h.deps, { accountId: ACCOUNT, realmId: REALM2, sig: SIG }),
    ).toMatchObject({ ok: false, status: 409, error: 'launch_sig_replayed' });
    expect(mint).not.toBe(prep.mint);
  });
});

// ── Verify locks ─────────────────────────────────────────────────────────────

describe('verifyLaunch', () => {
  it('verifies the full fair-launch state and stamps locks_verified_at', async () => {
    const { h, mint } = await confirmedHarness();
    distribute(h, mint);
    const res = await verifyLaunch(h.deps, LOCK_ARGS);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.checks.filter((c) => !c.ok)).toEqual([]);
    expect(res.verified).toBe(true);
    expect((await h.launches.getLaunch(REALM))?.locksVerifiedAt).not.toBeNull();
  });

  it('requires a confirmed mint and three distinct lock addresses', async () => {
    const { h } = await preparedHarness();
    expect(await verifyLaunch(h.deps, LOCK_ARGS)).toMatchObject({
      ok: false,
      status: 409,
      error: 'mint_not_created',
    });

    const { h: h2 } = await confirmedHarness();
    expect(
      await verifyLaunch(h2.deps, { ...LOCK_ARGS, levyLock: LOCK_ARGS.founderLock }),
    ).toMatchObject({ ok: false, status: 400, error: 'invalid_lock_address' });
    expect(await verifyLaunch(h2.deps, { ...LOCK_ARGS, treasuryLock: 'garbage' })).toMatchObject({
      ok: false,
      status: 400,
      error: 'invalid_lock_address',
    });
  });

  it('fails closed on every broken lock property, without stamping', async () => {
    const cases: Array<{
      name: string;
      mutate: (h: Harness, mint: string) => void;
      failing: string;
    }> = [
      {
        name: 'missing escrow',
        mutate: (h) => h.chain.escrows.delete(LEVY_LOCK),
        failing: 'levy_lock_found',
      },
      {
        name: 'wrong recipient',
        mutate: (h) => {
          const e = h.chain.escrows.get(LEVY_LOCK);
          if (e) h.chain.escrows.set(LEVY_LOCK, { ...e, recipient: FOUNDER });
        },
        failing: 'levy_lock_recipient',
      },
      {
        name: 'cancelable lock',
        mutate: (h) => {
          const e = h.chain.escrows.get(FOUNDER_LOCK);
          if (e) h.chain.escrows.set(FOUNDER_LOCK, { ...e, cancelMode: 1 });
        },
        failing: 'founder_lock_immutable',
      },
      {
        name: 'recipient-updatable lock',
        mutate: (h) => {
          const e = h.chain.escrows.get(FOUNDER_LOCK);
          if (e) h.chain.escrows.set(FOUNDER_LOCK, { ...e, updateRecipientMode: 2 });
        },
        failing: 'founder_lock_immutable',
      },
      {
        name: 'legacy token program escrow',
        mutate: (h) => {
          const e = h.chain.escrows.get(TREASURY_LOCK);
          if (e) h.chain.escrows.set(TREASURY_LOCK, { ...e, tokenProgramFlag: 0 });
        },
        failing: 'treasury_lock_token_program',
      },
      {
        name: 'already claimed',
        mutate: (h) => {
          const e = h.chain.escrows.get(FOUNDER_LOCK);
          if (e) h.chain.escrows.set(FOUNDER_LOCK, { ...e, totalClaimedAmount: 1n });
        },
        failing: 'founder_lock_untouched',
      },
      {
        name: 'one base unit short',
        mutate: (h) => {
          const e = h.chain.escrows.get(FOUNDER_LOCK);
          if (e) {
            h.chain.escrows.set(FOUNDER_LOCK, {
              ...e,
              cliffUnlockAmount: e.cliffUnlockAmount - 1n,
            });
          }
        },
        failing: 'founder_lock_amount',
      },
      {
        name: 'backdated cliff',
        mutate: (h) => {
          const e = h.chain.escrows.get(FOUNDER_LOCK);
          const now = BigInt(Math.floor(Date.now() / 1000));
          if (e) h.chain.escrows.set(FOUNDER_LOCK, { ...e, cliffTime: now + 86_400n });
        },
        failing: 'founder_lock_schedule',
      },
      {
        name: 'short linear tail',
        mutate: (h) => {
          const e = h.chain.escrows.get(LEVY_LOCK);
          if (e) h.chain.escrows.set(LEVY_LOCK, { ...e, numberOfPeriod: 12n });
        },
        // 12 periods also breaks the exact amount; the schedule floor is the
        // check under test, so assert it specifically.
        failing: 'levy_lock_schedule',
      },
      {
        name: 'unfunded escrow',
        mutate: (h, mint) => h.chain.balances.delete(`${mint}:${TREASURY_LOCK}`),
        failing: 'treasury_lock_funded',
      },
      {
        name: 'supply not fully minted',
        mutate: (h, mint) => {
          const s = h.chain.mints.get(mint);
          if (s) h.chain.mints.set(mint, { ...s, supply: s.supply - 1n });
        },
        failing: 'supply_exact',
      },
      {
        name: 'mint authority retained',
        mutate: (h, mint) => {
          const s = h.chain.mints.get(mint);
          if (s) h.chain.mints.set(mint, { ...s, mintAuthority: FOUNDER });
        },
        failing: 'mint_authority_renounced',
      },
    ];
    for (const c of cases) {
      const { h, mint } = await confirmedHarness();
      distribute(h, mint);
      c.mutate(h, mint);
      const res = await verifyLaunch(h.deps, LOCK_ARGS);
      expect(res.ok).toBe(true);
      if (!res.ok) continue;
      expect(res.verified, c.name).toBe(false);
      const failed = res.checks.filter((x) => !x.ok).map((x) => x.check);
      expect(failed, c.name).toContain(c.failing);
      expect((await h.launches.getLaunch(REALM))?.locksVerifiedAt, c.name).toBeNull();
    }
  });

  it('re-verifies from the pinned addresses once verified', async () => {
    const { h, mint } = await confirmedHarness();
    distribute(h, mint);
    expect(await verifyLaunch(h.deps, LOCK_ARGS)).toMatchObject({ ok: true, verified: true });
    // A later call with DIFFERENT addresses ignores them: the pinned proof
    // links stay what was verified.
    const res = await verifyLaunch(h.deps, {
      accountId: ACCOUNT,
      realmId: REALM,
      founderLock: LEVY_LOCK,
      levyLock: FOUNDER_LOCK,
      treasuryLock: TREASURY_LOCK,
    });
    expect(res).toMatchObject({ ok: true, verified: true });
    const launch = await h.launches.getLaunch(REALM);
    expect(launch?.founderLockAddress).toBe(FOUNDER_LOCK);
  });
});

// ── Listing gate ─────────────────────────────────────────────────────────────

describe('listing gate', () => {
  it('blocks live before locks are verified, and before a curve exists', async () => {
    const { h, mint } = await confirmedHarness();
    expect(await listRealmToken(h.deps, REALM)).toMatchObject({
      ok: false,
      status: 409,
      error: 'locks_not_verified',
    });

    distribute(h, mint);
    await verifyLaunch(h.deps, LOCK_ARGS);
    // Locks verified but no curve yet (phase 4): still blocked.
    expect(await listRealmToken(h.deps, REALM)).toMatchObject({
      ok: false,
      status: 409,
      error: 'locks_not_verified',
    });

    const token = h.tokens.rows.get(REALM);
    if (token) h.tokens.rows.set(REALM, { ...token, curveAddress: LEVY });
    const res = await listRealmToken(h.deps, REALM);
    expect(res).toMatchObject({ ok: true, status: 'live' });
    expect((await h.tokens.getRealmToken(REALM))?.status).toBe('live');
  });

  it('launchReadyToList is pure and demands every precondition', async () => {
    const { h, mint } = await confirmedHarness();
    distribute(h, mint);
    await verifyLaunch(h.deps, LOCK_ARGS);
    const launch = await h.launches.getLaunch(REALM);
    const token = await h.tokens.getRealmToken(REALM);
    if (!launch || !token) throw new Error('fixture');
    expect(launchReadyToList(null, token)).toBe(false);
    expect(launchReadyToList(launch, token)).toBe(false); // no curve
    const withCurve = { ...token, curveAddress: LEVY };
    expect(launchReadyToList(launch, withCurve)).toBe(true);
    expect(launchReadyToList({ ...launch, locksVerifiedAt: null }, withCurve)).toBe(false);
    expect(launchReadyToList(launch, { ...withCurve, mint: null })).toBe(false);
  });
});

// ── Panel read ───────────────────────────────────────────────────────────────

describe('launchStatus', () => {
  it('reports the pipeline state without touching the chain', async () => {
    const h = harness();
    h.tokens.rows.set(REALM, tokenRow(REALM));
    expect(await launchStatus(h.deps, REALM)).toMatchObject({
      ok: true,
      launch: { prepared: false, mintConfirmed: false, locksVerified: false },
    });

    const { h: h2, mint } = await confirmedHarness();
    distribute(h2, mint);
    await verifyLaunch(h2.deps, LOCK_ARGS);
    const res = await launchStatus(h2.deps, REALM);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.launch).toMatchObject({
      prepared: true,
      mint,
      mintConfirmed: true,
      locksVerified: true,
    });
    expect(res.launch.lockAddresses).toEqual({
      founder: FOUNDER_LOCK,
      levy: LEVY_LOCK,
      treasury: TREASURY_LOCK,
    });
    expect(res.launch.split?.publicBase).toBe(
      splitSupplyBase(realmTokenSupplyBase(), resolveAllocationBps({})).publicBase.toString(),
    );
  });
});
