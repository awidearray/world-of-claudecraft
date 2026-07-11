// Launchpad phase 0 (realm token registry): the pure currency resolver + its
// $WOC fallback, symbol/icon/policy validation, the directory currency merge,
// the register orchestration against an in-memory RealmTokenDb fake, and the
// assertRealmSchema boot drift guard (a dropped realm_tokens column must fail
// at boot). The real-Postgres variant of the DB surface lives in
// tests/realm_launchpad_db.integration.test.ts.

import { describe, expect, it } from 'vitest';
import { type DbRealmSummary, mergeRealmDirectory, type RealmEntry } from '../server/realm';
import { assertRealmSchema } from '../server/realm_db';
import {
  isMonetizationPolicy,
  isRealmTokenIcon,
  isRealmTokenSymbol,
  type MonetizationPolicy,
  mergeDirectoryCurrencies,
  type RealmToken,
  type RealmTokenDb,
  type RealmTokenStatus,
  realmTokenConfig,
  registerRealmToken,
  WOC_CURRENCY,
} from '../server/realm_token';

function token(realmId: number, over: Partial<RealmToken> = {}): RealmToken {
  return {
    realmId,
    mint: null,
    decimals: 9,
    symbol: 'MOON',
    icon: '',
    status: 'prelaunch',
    monetizationPolicy: 'cosmetic',
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

// In-memory RealmTokenDb fake implementing the interface the logic talks to.
class UniqueViolation extends Error {}
export class FakeRealmTokenDb implements RealmTokenDb {
  rows = new Map<number, RealmToken>();
  async getRealmToken(realmId: number): Promise<RealmToken | null> {
    return this.rows.get(realmId) ?? null;
  }
  async insertRealmToken(t: {
    realmId: number;
    symbol: string;
    icon: string;
    monetizationPolicy: MonetizationPolicy;
  }): Promise<RealmToken> {
    if (this.rows.has(t.realmId)) throw new UniqueViolation('duplicate realm token');
    const row = token(t.realmId, {
      symbol: t.symbol,
      icon: t.icon,
      monetizationPolicy: t.monetizationPolicy,
    });
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
    const next = { ...row, status: to, updatedAt: new Date() };
    this.rows.set(realmId, next);
    return next;
  }
}

export const isFakeUnique = (err: unknown): boolean => err instanceof UniqueViolation;

describe('identity validation', () => {
  it('accepts ticker-style symbols and rejects the rest', () => {
    expect(isRealmTokenSymbol('MOON')).toBe(true);
    expect(isRealmTokenSymbol('AB')).toBe(true);
    expect(isRealmTokenSymbol('A1234567B9')).toBe(true);
    expect(isRealmTokenSymbol('A')).toBe(false); // too short
    expect(isRealmTokenSymbol('ABCDEFGHIJK')).toBe(false); // too long
    expect(isRealmTokenSymbol('moon')).toBe(false); // lowercase
    expect(isRealmTokenSymbol('1UP')).toBe(false); // digit first
    expect(isRealmTokenSymbol('WOC')).toBe(false); // reserved for the fallback
  });

  it('bounds icon ids and allows empty', () => {
    expect(isRealmTokenIcon('')).toBe(true);
    expect(isRealmTokenIcon('moon_coin-2')).toBe(true);
    expect(isRealmTokenIcon('UPPER')).toBe(false);
    expect(isRealmTokenIcon('a'.repeat(33))).toBe(false);
  });

  it('recognizes exactly the two monetization policies', () => {
    expect(isMonetizationPolicy('cosmetic')).toBe(true);
    expect(isMonetizationPolicy('power')).toBe(true);
    expect(isMonetizationPolicy('p2w')).toBe(false);
  });
});

describe('realmTokenConfig (pure resolver)', () => {
  const tokens = new Map<number, RealmToken>([
    [7, token(7, { symbol: 'MOON', icon: 'moon', status: 'voting' })],
    [8, token(8, { symbol: 'DEAD', status: 'closed' })],
  ]);

  it('resolves a registered token to its display identity', () => {
    const c = realmTokenConfig(7, tokens);
    expect(c).toMatchObject({ symbol: 'MOON', icon: 'moon', realmToken: true, status: 'voting' });
    expect(c.monetizationPolicy).toBe('cosmetic');
  });

  it('falls back to the $WOC display currency for an unregistered realm', () => {
    expect(realmTokenConfig(99, tokens)).toEqual(WOC_CURRENCY);
    expect(WOC_CURRENCY.symbol).toBe('WOC');
    expect(WOC_CURRENCY.realmToken).toBe(false);
  });

  it('falls back for env-only realms (null id) and closed tokens', () => {
    expect(realmTokenConfig(null, tokens)).toEqual(WOC_CURRENCY);
    expect(realmTokenConfig(8, tokens)).toEqual(WOC_CURRENCY);
  });
});

describe('directory currency merge', () => {
  const env: RealmEntry[] = [{ name: 'Claudemoon', url: '', type: 'Normal' }];
  const db: DbRealmSummary[] = [
    {
      realmId: 1,
      name: 'Claudemoon',
      type: 'Normal',
      originUrl: '',
      status: 'active',
      ownerAccountId: null,
      tier: 0,
    },
    {
      realmId: 7,
      name: 'Moonrealm',
      type: 'PvP',
      originUrl: 'https://moon.example.com',
      status: 'active',
      ownerAccountId: 42,
      tier: 2,
    },
  ];

  it('attaches each merged entry its currency, additive to the existing shape', () => {
    const merged = mergeRealmDirectory(env, db);
    const tokens = new Map([[7, token(7, { symbol: 'MOON', status: 'presale' })]]);
    const out = mergeDirectoryCurrencies(merged, tokens);
    expect(out).toHaveLength(2);
    // The default realm keeps the $WOC display identity.
    const def = out.find((r) => r.name === 'Claudemoon')!;
    expect(def.currency).toEqual(WOC_CURRENCY);
    // The tokenized realm surfaces its own currency; the RealmEntry fields survive.
    const moon = out.find((r) => r.name === 'Moonrealm')!;
    expect(moon.currency).toMatchObject({ symbol: 'MOON', realmToken: true, status: 'presale' });
    expect(moon).toMatchObject({
      url: 'https://moon.example.com',
      type: 'PvP',
      tier: 2,
      owned: true,
    });
  });

  it('gives an env-only realm (no registry row) the $WOC fallback', () => {
    const merged = mergeRealmDirectory([{ name: 'EnvOnly', url: '', type: 'Normal' }], []);
    const out = mergeDirectoryCurrencies(merged, new Map());
    expect(out[0].realmId).toBeNull();
    expect(out[0].currency).toEqual(WOC_CURRENCY);
  });
});

describe('registerRealmToken', () => {
  function deps(over: Partial<Parameters<typeof registerRealmToken>[0]> = {}) {
    return {
      tokens: new FakeRealmTokenDb(),
      rolesForAccountOnRealm: async () => ['owner'] as import('../server/realm').RealmRole[],
      realmStatus: async () => 'active' as string | null,
      isUniqueViolation: isFakeUnique,
      ...over,
    };
  }
  const args = { accountId: 1, realmId: 7, symbol: 'MOON' };

  it('registers a prelaunch token with the cosmetic default policy', async () => {
    const d = deps();
    const r = await registerRealmToken(d, args);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.token).toMatchObject({
      symbol: 'MOON',
      status: 'prelaunch',
      monetizationPolicy: 'cosmetic',
      mint: null,
    });
  });

  it('stores the power policy as data only (no behavior attaches here)', async () => {
    const d = deps();
    const r = await registerRealmToken(d, { ...args, monetizationPolicy: 'power' });
    expect(r.ok && r.token.monetizationPolicy === 'power').toBe(true);
  });

  it('normalizes the symbol to upper case', async () => {
    const r = await registerRealmToken(deps(), { ...args, symbol: 'moon' });
    expect(r.ok && r.token.symbol === 'MOON').toBe(true);
  });

  it('is owner-only', async () => {
    const r = await registerRealmToken(
      deps({ rolesForAccountOnRealm: async () => ['moderator'] }),
      args,
    );
    expect(r).toMatchObject({ ok: false, status: 403, error: 'not_realm_owner' });
  });

  it('requires an active realm', async () => {
    expect(
      await registerRealmToken(deps({ realmStatus: async () => 'provisioning' }), args),
    ).toMatchObject({ ok: false, status: 409, error: 'realm_not_active' });
    expect(await registerRealmToken(deps({ realmStatus: async () => null }), args)).toMatchObject({
      ok: false,
      status: 404,
      error: 'realm_not_found',
    });
  });

  it('rejects invalid identity fields with typed errors', async () => {
    expect(await registerRealmToken(deps(), { ...args, symbol: 'WOC' })).toMatchObject({
      ok: false,
      error: 'invalid_token_symbol',
    });
    expect(await registerRealmToken(deps(), { ...args, icon: 'NOPE!' })).toMatchObject({
      ok: false,
      error: 'invalid_token_icon',
    });
    expect(await registerRealmToken(deps(), { ...args, monetizationPolicy: 'p2w' })).toMatchObject({
      ok: false,
      error: 'invalid_token_policy',
    });
  });

  it('registers at most one token per realm (pre-check and race both 409)', async () => {
    const d = deps();
    expect((await registerRealmToken(d, args)).ok).toBe(true);
    expect(await registerRealmToken(d, { ...args, symbol: 'MOON2' })).toMatchObject({
      ok: false,
      status: 409,
      error: 'token_already_registered',
    });
    // The insert race (unique violation with no pre-existing read) maps the same.
    const racing = deps();
    racing.tokens.getRealmToken = async () => null; // reads miss, insert collides
    await racing.tokens.insertRealmToken({
      realmId: 7,
      symbol: 'X1',
      icon: '',
      monetizationPolicy: 'cosmetic',
    });
    expect(await registerRealmToken(racing, args)).toMatchObject({
      ok: false,
      status: 409,
      error: 'token_already_registered',
    });
  });
});

describe('assertRealmSchema drift guard (launchpad tables)', () => {
  // A stub Queryable serving information_schema.columns from a plan: the full
  // expected column set, minus whatever the test drops.
  const FULL: Record<string, string[]> = {
    realms: [
      'realm_id',
      'name',
      'status',
      'owner_account_id',
      'tier',
      'world_seed',
      'release_eligible_at',
    ],
    realm_stakes: ['stake_id', 'realm_id', 'amount_base', 'lock_tx_sig', 'status'],
    realm_quotes: ['quote_id', 'realm_id', 'amount_base', 'expires_at'],
    realm_buy_quotes: [
      'quote_id',
      'realm_id',
      'currency',
      'total_base',
      'treasury_base',
      'buyback_base',
      'bond_base',
      'expires_at',
    ],
    realm_purchases: [
      'purchase_id',
      'realm_id',
      'currency',
      'total_base',
      'treasury_base',
      'buyback_base',
      'pay_tx_sig',
    ],
    realm_bonds: ['realm_id', 'account_id', 'bond_base', 'grace_until'],
    realm_tokens: [
      'realm_id',
      'mint',
      'decimals',
      'symbol',
      'status',
      'monetization_policy',
      'launch_tx_sig',
    ],
    realm_votes: ['vote_id', 'realm_id', 'account_id', 'wallet', 'choice', 'weight_woc'],
    realm_presales: [
      'realm_id',
      'escrow_wallet',
      'sol_soft_cap_base',
      'usdc_soft_cap_base',
      'woc_soft_cap_base',
    ],
    realm_presale_quotes: [
      'quote_id',
      'realm_id',
      'account_id',
      'wallet',
      'currency',
      'amount_base',
      'expires_at',
    ],
    realm_presale_contributions: [
      'contribution_id',
      'realm_id',
      'account_id',
      'wallet',
      'currency',
      'amount_base',
      'pay_tx_sig',
      'refund_tx_sig',
    ],
  };
  function stubDb(drop?: { table: string; column: string }) {
    return {
      query: async (_sql: string, params?: unknown[]) => {
        const table = String(params?.[0]);
        const cols = (FULL[table] ?? []).filter(
          (c) => !(drop && drop.table === table && drop.column === c),
        );
        return { rows: cols.map((c) => ({ column_name: c })) } as never;
      },
    };
  }

  it('passes with the full launchpad column set', async () => {
    await expect(assertRealmSchema(stubDb() as never)).resolves.toBeUndefined();
  });

  it('fails at boot when a realm_tokens column is dropped', async () => {
    await expect(
      assertRealmSchema(stubDb({ table: 'realm_tokens', column: 'monetization_policy' }) as never),
    ).rejects.toThrow(/realm_tokens.*monetization_policy/);
  });

  it('fails at boot when a money-table replay-guard column is dropped', async () => {
    await expect(
      assertRealmSchema(
        stubDb({ table: 'realm_presale_contributions', column: 'pay_tx_sig' }) as never,
      ),
    ).rejects.toThrow(/realm_presale_contributions.*pay_tx_sig/);
    await expect(
      assertRealmSchema(stubDb({ table: 'realm_votes', column: 'weight_woc' }) as never),
    ).rejects.toThrow(/realm_votes.*weight_woc/);
  });
});
