// Buyer self-serve panel for The Claudemoon Gazette ad marketplace. Wallet-based
// advertiser sign-in → pick placement/day/minutes → upload creative → reserve →
// quote → pay (USDC/SOL/WOC) → confirm. Reachable from the newspaper's
// "Advertise" button and the start-screen nav. Renders into #ad-buy-window.
//
// Lives in src/ui/ but imports the wallet from net/ (same precedent as
// ui/wallet_balance.ts) — wallet connect/sign/pay is a cross-cutting concern.
import { t, formatDateTime } from './i18n';
import { adsApi, type PlacementClient, type AdQuoteClient } from '../net/ads_api';
import { openWalletModal, currentWallet, signMessageBase58, payAdQuote } from '../net/wallet';
import type { AdAssetClient } from '../world_api';

const ASSET_DECIMALS: Record<AdAssetClient, number> = { USDC: 6, SOL: 9, WOC: 6 };

function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
}

// base-unit string → human number, trimmed.
function human(base: string, decimals: number): number {
  return Number(BigInt(base)) / 10 ** decimals;
}
function fmt(n: number): string {
  return n.toLocaleString(undefined, { maximumFractionDigits: 6 });
}

export class AdBuyPanel {
  private el: HTMLElement | null = null;
  private placements: PlacementClient[] = [];
  private busy = false;

  private root(): HTMLElement {
    if (!this.el) this.el = document.getElementById('ad-buy-window');
    return this.el!;
  }

  async open(): Promise<void> {
    const el = this.root();
    if (!el) return;
    el.classList.add('visible');
    el.setAttribute('aria-hidden', 'false');
    this.render();
    try {
      this.placements = (await adsApi.placements()).placements;
    } catch {
      this.placements = [];
    }
    this.render();
    if (adsApi.isAuthed()) void this.refreshBookings();
  }

  close(): void {
    const el = this.root();
    if (!el) return;
    el.classList.remove('visible');
    el.setAttribute('aria-hidden', 'true');
  }

  private setMsg(text: string, kind: 'info' | 'error' | 'ok' = 'info'): void {
    const m = document.getElementById('adb-msg');
    if (m) {
      m.textContent = text;
      m.className = `adb-msg adb-${kind}`;
    }
  }

  private render(): void {
    const el = this.root();
    if (!el) return;
    const authed = adsApi.isAuthed();
    const walletChip = authed
      ? `<div class="adb-chip">${esc(t('adbuy.signedInAs', { pubkey: shortKey(adsApi.pubkey ?? '') }))}
           <button type="button" class="adb-link" data-signout>${esc(t('adbuy.signOut'))}</button></div>`
      : `<button type="button" class="adb-connect" data-connect>${esc(t('adbuy.connectWallet'))}</button>`;

    const placementOpts = this.placements
      .map((p) => `<option value="${esc(p.id)}">${esc(p.displayName)}</option>`)
      .join('');

    el.innerHTML = `
      <div class="adb-card">
        <div class="adb-head">
          <h2>${esc(t('adbuy.title'))}</h2>
          <button type="button" class="adb-x" data-close aria-label="${esc(t('adbuy.close'))}">×</button>
        </div>
        <p class="adb-sub">${esc(t('adbuy.subtitle'))}</p>
        <div class="adb-wallet">${walletChip}</div>
        <div class="adb-form" ${authed ? '' : 'data-disabled'}>
          <label class="adb-field"><span>${esc(t('adbuy.placementLabel'))}</span>
            <select id="adb-placement">${placementOpts}</select></label>
          <label class="adb-field"><span>${esc(t('adbuy.assetLabel'))}</span>
            <select id="adb-asset"><option value="USDC">USDC</option><option value="SOL">SOL</option><option value="WOC">$WOC</option></select></label>
          <div class="adb-row">
            <label class="adb-field"><span>${esc(t('adbuy.dayLabel'))}</span><input type="date" id="adb-day"></label>
            <label class="adb-field"><span>${esc(t('adbuy.startLabel'))}</span><input type="time" id="adb-start"></label>
            <label class="adb-field"><span>${esc(t('adbuy.minutesLabel'))}</span><input type="number" id="adb-minutes" min="1" value="10"></label>
          </div>
          <div id="adb-creative" class="adb-creative"></div>
          <p class="adb-hint">${esc(t('adbuy.realWorldHint'))}</p>
          <label class="adb-field"><span>${esc(t('adbuy.clickUrl'))}</span><input type="url" id="adb-url" placeholder="https://"></label>
          <label class="adb-field"><span>${esc(t('adbuy.cta'))}</span><input type="text" id="adb-cta" maxlength="40"></label>
          <div class="adb-total" id="adb-total"></div>
          <button type="button" class="adb-submit" id="adb-submit">${esc(t('adbuy.reservePay'))}</button>
          <div class="adb-msg adb-info" id="adb-msg"></div>
        </div>
        <div class="adb-bookings">
          <h3>${esc(t('adbuy.myBookings'))}</h3>
          <ul id="adb-bookings-list"><li class="adb-empty">${esc(t('adbuy.noBookings'))}</li></ul>
        </div>
      </div>`;

    el.querySelector('[data-close]')?.addEventListener('click', () => this.close());
    el.querySelector('[data-connect]')?.addEventListener('click', () => void this.connect());
    el.querySelector('[data-signout]')?.addEventListener('click', () => { adsApi.signOut(); this.render(); });
    if (authed) {
      const pl = document.getElementById('adb-placement') as HTMLSelectElement | null;
      const as = document.getElementById('adb-asset') as HTMLSelectElement | null;
      const mn = document.getElementById('adb-minutes') as HTMLInputElement | null;
      const onChange = () => { this.renderCreativeInput(); this.updateTotal(); };
      pl?.addEventListener('change', onChange);
      as?.addEventListener('change', () => this.updateTotal());
      mn?.addEventListener('input', () => this.updateTotal());
      document.getElementById('adb-submit')?.addEventListener('click', () => void this.submit());
      this.renderCreativeInput();
      this.updateTotal();
      void this.refreshBookings();
    }
  }

  private selectedPlacement(): PlacementClient | null {
    const id = (document.getElementById('adb-placement') as HTMLSelectElement | null)?.value;
    return this.placements.find((p) => p.id === id) ?? null;
  }

  private renderCreativeInput(): void {
    const wrap = document.getElementById('adb-creative');
    const p = this.selectedPlacement();
    if (!wrap || !p) return;
    if (p.creativeType === 'image') {
      const dims = p.creativeW && p.creativeH ? ` (${p.creativeW}×${p.creativeH})` : '';
      wrap.innerHTML = `<label class="adb-field"><span>${esc(t('adbuy.creativeImage'))}${esc(dims)}</span>
        <input type="file" id="adb-img" accept="image/png"></label>`;
    } else {
      wrap.innerHTML = `<label class="adb-field"><span>${esc(t('adbuy.creativeText'))}</span>
        <textarea id="adb-text" maxlength="280" rows="2"></textarea></label>`;
    }
  }

  private currentAsset(): AdAssetClient {
    return ((document.getElementById('adb-asset') as HTMLSelectElement | null)?.value as AdAssetClient) ?? 'USDC';
  }
  private currentMinutes(): number {
    return Math.max(1, Math.trunc(Number((document.getElementById('adb-minutes') as HTMLInputElement | null)?.value) || 0));
  }

  private updateTotal(): void {
    const totalEl = document.getElementById('adb-total');
    const p = this.selectedPlacement();
    if (!totalEl || !p?.rateCard) return;
    const asset = this.currentAsset();
    const dec = ASSET_DECIMALS[asset];
    const perMinBase = asset === 'USDC' ? p.rateCard.usdcPerMinBase : asset === 'SOL' ? p.rateCard.solPerMinBase : p.rateCard.wocPerMinBase;
    const minutes = this.currentMinutes();
    const totalBase = (BigInt(perMinBase) * BigInt(minutes)).toString();
    totalEl.innerHTML =
      `<span>${esc(t('adbuy.pricePerMin', { price: fmt(human(perMinBase, dec)), asset }))}</span>` +
      `<strong>${esc(t('adbuy.totalLabel'))}: ${fmt(human(totalBase, dec))} ${esc(asset)}</strong>`;
  }

  private async connect(): Promise<void> {
    try {
      this.setMsg(t('adbuy.connecting'));
      if (!currentWallet().isConnected) {
        await openWalletModal();
        await waitForWallet();
      }
      const addr = currentWallet().address;
      if (!addr) return this.setMsg(t('adbuy.needWallet'), 'error');
      const { nonce, message } = await adsApi.challenge(addr);
      const signature = await signMessageBase58(message);
      await adsApi.auth(addr, signature, nonce);
      this.render();
    } catch (err) {
      this.setMsg(t('adbuy.errPrefix', { error: errText(err) }), 'error');
    }
  }

  private async submit(): Promise<void> {
    if (this.busy) return;
    if (!adsApi.isAuthed()) return this.setMsg(t('adbuy.needWallet'), 'error');
    const p = this.selectedPlacement();
    if (!p) return;
    const asset = this.currentAsset();
    const minutes = this.currentMinutes();
    const day = (document.getElementById('adb-day') as HTMLInputElement | null)?.value ?? '';
    const start = (document.getElementById('adb-start') as HTMLInputElement | null)?.value ?? '';
    const startsAt = Date.parse(`${day}T${start || '00:00'}:00Z`);
    if (!Number.isFinite(startsAt)) return this.setMsg(t('adbuy.errPrefix', { error: 'invalid date/time' }), 'error');
    const clickUrl = (document.getElementById('adb-url') as HTMLInputElement | null)?.value.trim() ?? '';
    const cta = (document.getElementById('adb-cta') as HTMLInputElement | null)?.value.trim() ?? '';

    this.busy = true;
    this.setMsg(t('adbuy.working'));
    try {
      // 1. creative
      let creativeId: number;
      if (p.creativeType === 'image') {
        const file = (document.getElementById('adb-img') as HTMLInputElement | null)?.files?.[0];
        if (!file) throw new Error(t('adbuy.needCreative'));
        creativeId = (await adsApi.uploadImageCreative(file, clickUrl, cta)).creativeId;
      } else {
        const text = (document.getElementById('adb-text') as HTMLTextAreaElement | null)?.value.trim() ?? '';
        if (!text) throw new Error(t('adbuy.needCreative'));
        creativeId = (await adsApi.uploadTextCreative(text, clickUrl, cta)).creativeId;
      }
      // 2. reserve
      const reserved = await adsApi.reserve({ placement: p.id, asset, startsAt, minutes, creativeId });
      // 3. quote
      const quote: AdQuoteClient = await adsApi.quote(reserved.bookingId);
      // 4. pay on-chain
      const signature = await payAdQuote({
        asset: quote.asset,
        mint: quote.mint,
        decimals: quote.decimals,
        amountBase: quote.amountBase,
        treasury: quote.treasury,
        memo: quote.memo,
      });
      // 5. confirm + settle
      await adsApi.confirm(quote.quoteId, signature);
      this.setMsg(t('adbuy.success'), 'ok');
      void this.refreshBookings();
    } catch (err) {
      this.setMsg(t('adbuy.errPrefix', { error: errText(err) }), 'error');
    } finally {
      this.busy = false;
    }
  }

  private async refreshBookings(): Promise<void> {
    const list = document.getElementById('adb-bookings-list');
    if (!list || !adsApi.isAuthed()) return;
    try {
      const { bookings } = await adsApi.myBookings();
      if (bookings.length === 0) {
        list.innerHTML = `<li class="adb-empty">${esc(t('adbuy.noBookings'))}</li>`;
        return;
      }
      list.innerHTML = bookings
        .map((b) => {
          const when = formatDateTime(b.startSec * 1000, { dateStyle: 'medium', timeStyle: 'short' });
          return `<li><span class="adb-bk-when">${esc(when)}</span>
            <span class="adb-bk-place">${esc(b.placement)}</span>
            <span class="adb-bk-status adb-st-${esc(b.status)}">${esc(b.status)}</span></li>`;
        })
        .join('');
    } catch {
      /* leave the empty state */
    }
  }
}

function shortKey(k: string): string {
  return k.length > 12 ? `${k.slice(0, 4)}…${k.slice(-4)}` : k;
}
function errText(err: unknown): string {
  return err instanceof Error ? err.message : 'unknown error';
}
function waitForWallet(): Promise<void> {
  return new Promise((resolve) => {
    if (currentWallet().address) return resolve();
    const timer = window.setInterval(() => {
      if (currentWallet().address) {
        window.clearInterval(timer);
        resolve();
      }
    }, 300);
    window.setTimeout(() => {
      window.clearInterval(timer);
      resolve();
    }, 60000);
  });
}
