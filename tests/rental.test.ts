import { describe, expect, it, beforeEach } from 'vitest';
import {
  RentalService, tierForScore, sanitizeRig,
  SIGNUP_STIPEND, HOST_MIN_SCORE, BILL_INTERVAL_MS,
  type RentalDb, type RentalTransport, type RentalEvent, type RentalActor, type RigProfile,
} from '../server/rental';

// --- In-memory fakes ---------------------------------------------------------

// A double-entry $woc ledger, exactly the contract PgRentalDb satisfies.
class FakeDb implements RentalDb {
  balances = new Map<number, number>();
  ledger: { from: number | null; to: number; amount: number; reason: string }[] = [];

  async getBalance(charId: number): Promise<number> {
    if (!this.balances.has(charId)) {
      this.balances.set(charId, SIGNUP_STIPEND);
      this.ledger.push({ from: null, to: charId, amount: SIGNUP_STIPEND, reason: 'stipend:signup' });
    }
    return this.balances.get(charId)!;
  }

  async transfer(fromId: number, toId: number, amount: number, reason: string): Promise<boolean> {
    if (amount <= 0 || fromId === toId) return false;
    const from = await this.getBalance(fromId);
    await this.getBalance(toId);
    if (from < amount) return false;
    this.balances.set(fromId, from - amount);
    this.balances.set(toId, this.balances.get(toId)! + amount);
    this.ledger.push({ from: fromId, to: toId, amount, reason });
    return true;
  }
}

class FakeTransport implements RentalTransport {
  online = new Set<number>();
  actors = new Map<number, RentalActor>();
  events = new Map<number, RentalEvent[]>();
  pushes = new Map<number, number>();

  add(actor: RentalActor) { this.actors.set(actor.characterId, actor); this.online.add(actor.characterId); }
  isOnline(id: number) { return this.online.has(id); }
  byCharacterId(id: number) { return this.actors.get(id) ?? null; }
  deliver(id: number, events: RentalEvent[]) {
    const arr = this.events.get(id) ?? [];
    arr.push(...events);
    this.events.set(id, arr);
  }
  pushMarket(id: number) { this.pushes.set(id, (this.pushes.get(id) ?? 0) + 1); }

  eventsFor(id: number) { return this.events.get(id) ?? []; }
  typesFor(id: number) { return this.eventsFor(id).map((e) => e.type); }
  clear() { this.events.clear(); this.pushes.clear(); }
}

const HIGH_RIG: RigProfile = { gpu: 'RTX 4090', score: 90, cores: 16, mobile: false, tier: 'ultra' };
const WEAK_RIG: RigProfile = { gpu: 'Intel UHD', score: 20, cores: 4, mobile: false, tier: 'low' };

function setup() {
  const db = new FakeDb();
  const tx = new FakeTransport();
  let clock = 1_000_000;
  const svc = new RentalService(db, tx, () => clock);
  const host: RentalActor = { characterId: 1, name: 'Hostius' };
  const renter: RentalActor = { characterId: 2, name: 'Poorlad' };
  tx.add(host); tx.add(renter);
  const advance = (ms: number) => { clock += ms; };
  return { db, tx, svc, host, renter, advance };
}

// --- Pure helpers ------------------------------------------------------------

describe('rig tiers + sanitize', () => {
  it('maps scores to tiers with hosting bar at high', () => {
    expect(tierForScore(10)).toBe('low');
    expect(tierForScore(40)).toBe('mid');
    expect(tierForScore(70)).toBe('high');
    expect(tierForScore(95)).toBe('ultra');
    expect(tierForScore(HOST_MIN_SCORE)).toBe('high');
  });

  it('sanitizes untrusted rig payloads', () => {
    const rig = sanitizeRig({ gpu: '<script>RTX 3080', score: 999, cores: -3, mobile: 1 });
    expect(rig).not.toBeNull();
    expect(rig!.gpu).not.toContain('<');
    expect(rig!.score).toBe(100); // clamped
    expect(rig!.cores).toBe(1); // clamped up from -3
    expect(rig!.mobile).toBe(true);
    expect(rig!.tier).toBe('ultra');
    expect(sanitizeRig(null)).toBeNull();
  });
});

// --- Wallet ------------------------------------------------------------------

describe('$woc wallet', () => {
  it('grants the signup stipend on first balance read', async () => {
    const { db } = setup();
    expect(await db.getBalance(7)).toBe(SIGNUP_STIPEND);
    expect(db.ledger.filter((l) => l.reason === 'stipend:signup')).toHaveLength(1);
  });

  it('sends the wallet balance to the client', async () => {
    const { svc, tx, host } = setup();
    await svc.sendWallet(host.characterId);
    const ev = tx.eventsFor(host.characterId).find((e) => e.type === 'wallet');
    expect(ev).toMatchObject({ type: 'wallet', balance: SIGNUP_STIPEND });
  });
});

// --- Hosting -----------------------------------------------------------------

describe('hosting a GPU', () => {
  it('refuses to list without a benchmark', () => {
    const { svc, tx, host } = setup();
    svc.list(host, 10, 1, 'cheap frames');
    expect(tx.typesFor(host.characterId)).toContain('error');
  });

  it('refuses to list a weak rig', () => {
    const { svc, tx, host } = setup();
    svc.reportRig(host, WEAK_RIG);
    svc.list(host, 10, 1, '');
    const err = tx.eventsFor(host.characterId).find((e) => e.type === 'error');
    expect(err && 'text' in err && err.text).toMatch(/requires/);
  });

  it('lists a strong rig and shows it to others', async () => {
    const { svc, host, renter } = setup();
    svc.reportRig(host, HIGH_RIG);
    svc.list(host, 25, 2, 'RTX power');
    const snap = await svc.snapshot(renter.characterId);
    expect(snap.listings).toHaveLength(1);
    expect(snap.listings[0]).toMatchObject({ hostName: 'Hostius', ratePerMin: 25, slots: 2, tier: 'ultra' });
    // host doesn't see its own listing in the browse list, but as myListing
    const hostSnap = await svc.snapshot(host.characterId);
    expect(hostSnap.listings).toHaveLength(0);
    expect(hostSnap.myListing).toMatchObject({ ratePerMin: 25 });
  });

  it('pulls the listing if the host re-benchmarks below the bar', async () => {
    const { svc, host, renter } = setup();
    svc.reportRig(host, HIGH_RIG);
    svc.list(host, 25, 1, '');
    svc.reportRig(host, WEAK_RIG); // switched to integrated graphics
    expect((await svc.snapshot(renter.characterId)).listings).toHaveLength(0);
  });
});

// --- Renting + billing -------------------------------------------------------

describe('renting + $woc billing', () => {
  beforeEach(() => {});

  it('prepays the first minute and starts a session on both peers', async () => {
    const { db, svc, tx, host, renter } = setup();
    svc.reportRig(host, HIGH_RIG);
    svc.list(host, 100, 1, '');
    tx.clear();
    await svc.rent(renter, host.characterId);

    expect(await db.getBalance(renter.characterId)).toBe(SIGNUP_STIPEND - 100);
    expect(await db.getBalance(host.characterId)).toBe(SIGNUP_STIPEND + 100);
    expect(tx.typesFor(host.characterId)).toContain('sessionStart');
    expect(tx.typesFor(renter.characterId)).toContain('sessionStart');
    const snap = await svc.snapshot(renter.characterId);
    expect(snap.session).toMatchObject({ role: 'renter', paid: 100, state: 'connecting' });
  });

  it('rejects renting with insufficient $woc', async () => {
    const { db, svc, tx, host, renter } = setup();
    db.balances.set(renter.characterId, 50);
    svc.reportRig(host, HIGH_RIG);
    svc.list(host, 100, 1, '');
    tx.clear();
    await svc.rent(renter, host.characterId);
    expect(tx.typesFor(renter.characterId)).toContain('error');
    expect(await svc.snapshot(renter.characterId)).toMatchObject({ session: null });
  });

  it('charges each elapsed minute and ends cleanly when the renter runs dry', async () => {
    const { db, svc, host, renter, advance } = setup();
    db.balances.set(renter.characterId, 250); // enough for start(100) + 1 tick(100), not 2
    svc.reportRig(host, HIGH_RIG);
    svc.list(host, 100, 1, '');
    await svc.rent(renter, host.characterId); // -100 -> 150

    advance(BILL_INTERVAL_MS);
    expect(await svc.tickBilling()).toBe(0); // -100 -> 50, still alive
    expect(await db.getBalance(renter.characterId)).toBe(50);

    advance(BILL_INTERVAL_MS);
    expect(await svc.tickBilling()).toBe(1); // can't afford -> ended
    expect(await db.getBalance(renter.characterId)).toBe(50); // unchanged on failed charge
    expect(await db.getBalance(host.characterId)).toBe(SIGNUP_STIPEND + 200);
    expect(await svc.snapshot(renter.characterId)).toMatchObject({ session: null });
  });

  it('bills every whole minute across a long gap', async () => {
    const { svc, db, host, renter, advance } = setup();
    svc.reportRig(host, HIGH_RIG);
    svc.list(host, 10, 1, '');
    await svc.rent(renter, host.characterId); // -10
    advance(BILL_INTERVAL_MS * 3 + 5_000); // 3 whole minutes elapsed
    await svc.tickBilling();
    expect(await db.getBalance(renter.characterId)).toBe(SIGNUP_STIPEND - 10 - 30);
  });

  it('frees the host slot when a rental ends', async () => {
    const { svc, host, renter } = setup();
    svc.reportRig(host, HIGH_RIG);
    svc.list(host, 10, 1, '');
    await svc.rent(renter, host.characterId);
    expect((await svc.snapshot(renter.characterId)).listings).toHaveLength(0); // slot full (busy>=slots)
    await svc.stop(renter);
    expect((await svc.snapshot(renter.characterId)).listings[0]).toMatchObject({ busy: 0 });
  });

  it('cannot rent your own GPU or rent twice', async () => {
    const { svc, tx, host, renter } = setup();
    svc.reportRig(host, HIGH_RIG);
    svc.list(host, 10, 2, '');
    await svc.rent(host, host.characterId);
    expect(tx.typesFor(host.characterId)).toContain('error');
    await svc.rent(renter, host.characterId);
    tx.clear();
    await svc.rent(renter, host.characterId); // already renting
    expect(tx.typesFor(renter.characterId)).toContain('error');
  });
});

// --- WebRTC signaling relay --------------------------------------------------

describe('signaling relay', () => {
  it('forwards handshake payloads to the counterpart only', async () => {
    const { svc, tx, host, renter } = setup();
    svc.reportRig(host, HIGH_RIG);
    svc.list(host, 10, 1, '');
    await svc.rent(renter, host.characterId);
    const sid = (await svc.snapshot(renter.characterId)).session!.id;
    tx.clear();

    svc.signal(renter, sid, { sdp: 'offer' });
    const hostSig = tx.eventsFor(host.characterId).find((e) => e.type === 'signal');
    expect(hostSig).toMatchObject({ type: 'signal', from: 'renter', payload: { sdp: 'offer' } });
    // renter (the sender) gets nothing back
    expect(tx.typesFor(renter.characterId)).not.toContain('signal');

    svc.signal(host, sid, { sdp: 'answer' });
    expect(tx.eventsFor(renter.characterId).find((e) => e.type === 'signal'))
      .toMatchObject({ from: 'host', payload: { sdp: 'answer' } });
  });

  it('ignores signals from non-members and after the session ends', async () => {
    const { svc, tx, host, renter } = setup();
    const stranger: RentalActor = { characterId: 99, name: 'Nosy' };
    tx.add(stranger);
    svc.reportRig(host, HIGH_RIG);
    svc.list(host, 10, 1, '');
    await svc.rent(renter, host.characterId);
    const sid = (await svc.snapshot(renter.characterId)).session!.id;
    tx.clear();
    svc.signal(stranger, sid, { sdp: 'evil' });
    expect(tx.typesFor(host.characterId)).not.toContain('signal');
    await svc.stop(renter);
    tx.clear();
    svc.signal(host, sid, { sdp: 'late' });
    expect(tx.typesFor(renter.characterId)).not.toContain('signal');
  });
});

// --- Disconnect teardown -----------------------------------------------------

describe('disconnect teardown', () => {
  it('ends the session and frees the listing when the host drops', async () => {
    const { svc, tx, host, renter } = setup();
    svc.reportRig(host, HIGH_RIG);
    svc.list(host, 10, 1, '');
    await svc.rent(renter, host.characterId);
    tx.clear();
    await svc.forget(host.characterId);
    const end = tx.eventsFor(renter.characterId).find((e) => e.type === 'sessionEnd');
    expect(end).toMatchObject({ reason: 'host_offline' });
    expect((await svc.snapshot(renter.characterId)).listings).toHaveLength(0);
    expect((await svc.snapshot(renter.characterId)).session).toBeNull();
  });
});
