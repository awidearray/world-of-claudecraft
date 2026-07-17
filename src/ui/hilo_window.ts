// Quartermaster's Hi-Lo window: a cold, self-contained modal for the RiverBoat
// hi-lo table. The player picks a copper stake from the ladder and calls HIGH or
// LOW; the client pre-validates the stake against live copper (the sim also
// re-checks, silently), then sends hiloPlay with a fresh random client seed
// (player entropy folded into the server's fair roll). The settled result
// arrives back as a hiloSettled event the HUD forwards to onSettled here.
//
// The pure logic (affordable rungs, legality, session fold) lives in
// hilo_view.ts; this module renders it and owns the modal lifecycle. It reaches
// the world only through IWorld and never imports Hud.
import type { IWorld } from '../world_api';
import { markDialogRoot } from './dialog_root';
import { esc } from './esc';
import { foldHiloResult, type HiloSession, type HiloSettledResult, hiloView } from './hilo_view';
import { formatMoney, t } from './i18n';

const ROOT_ID = 'hilo-window';

export interface HiloWindowDeps {
  // A getter (not the value) so the HUD can construct the window before the
  // world reference is assigned, matching the MailboxWindow pattern.
  world: () => IWorld;
}

export class HiloWindow {
  private stake = 100; // 1 silver, a sensible default rung
  private session: HiloSession = { wins: 0, losses: 0, net: 0 };
  private last: HiloSettledResult | null = null;
  private opener: HTMLElement | null = null;

  constructor(private readonly deps: HiloWindowDeps) {}

  get isOpen(): boolean {
    return document.getElementById(ROOT_ID) !== null;
  }

  open(): void {
    if (this.isOpen) return;
    this.opener = document.activeElement as HTMLElement | null;
    const backdrop = document.createElement('div');
    backdrop.id = ROOT_ID;
    backdrop.className = 'window-backdrop hilo-backdrop';
    const panel = document.createElement('div');
    panel.className = 'window panel hilo-panel';
    markDialogRoot(panel, { labelledBy: `${ROOT_ID}-title`, modal: true });
    backdrop.appendChild(panel);
    document.body.appendChild(backdrop);
    backdrop.addEventListener('click', (e) => {
      if (e.target === backdrop) this.close();
    });
    panel.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        this.close();
      }
    });
    this.render();
    panel.focus();
  }

  close(): void {
    document.getElementById(ROOT_ID)?.remove();
    this.opener?.focus?.();
    this.opener = null;
  }

  // The HUD forwards a hiloSettled event here while the window is open.
  onSettled(result: HiloSettledResult): void {
    this.last = result;
    this.session = foldHiloResult(this.session, result);
    if (this.isOpen) this.render();
  }

  private render(): void {
    const panel = document.querySelector<HTMLElement>(`#${ROOT_ID} .hilo-panel`);
    if (!panel) return;
    const view = hiloView(this.deps.world().copper, this.stake);

    const ladder = view.stakes
      .map(
        (opt) =>
          `<button type="button" class="hilo-stake${opt.selected ? ' sel' : ''}" data-stake="${
            opt.copper
          }"${opt.affordable ? '' : ' disabled'}>${esc(formatMoney(opt.copper))}</button>`,
      )
      .join('');

    const resultLine = this.last
      ? `<div class="hilo-result ${this.last.outcome}">${esc(
          this.last.outcome === 'win'
            ? t('hudChrome.hilo.wonLine', {
                roll: this.last.roll,
                amount: formatMoney(this.last.payout),
              })
            : t('hudChrome.hilo.lostLine', {
                roll: this.last.roll,
                amount: formatMoney(this.last.stake),
              }),
        )}</div>`
      : `<div class="hilo-result">${esc(t('hudChrome.hilo.prompt'))}</div>`;

    const record = t('hudChrome.hilo.session', {
      wins: this.session.wins,
      losses: this.session.losses,
    });

    panel.innerHTML =
      `<h2 class="window-title" id="${ROOT_ID}-title">${esc(t('hudChrome.hilo.title'))}</h2>` +
      `<p class="hilo-rules">${esc(t('hudChrome.hilo.rules'))}</p>` +
      `<div class="hilo-copper">${esc(t('hudChrome.hilo.balance', { amount: formatMoney(view.copper) }))}</div>` +
      `<div class="hilo-stakes" role="group" aria-label="${esc(t('hudChrome.hilo.stakeLabel'))}">${ladder}</div>` +
      resultLine +
      `<div class="hilo-actions">` +
      `<button type="button" class="btn hilo-lo" data-call="lo"${view.canPlay ? '' : ' disabled'}>${esc(t('hudChrome.hilo.low'))}</button>` +
      `<button type="button" class="btn hilo-hi" data-call="hi"${view.canPlay ? '' : ' disabled'}>${esc(t('hudChrome.hilo.high'))}</button>` +
      `</div>` +
      `<div class="hilo-session">${esc(record)}</div>` +
      `<div class="window-actions"><button type="button" class="btn" data-close>${esc(t('hudChrome.hilo.close'))}</button></div>`;

    for (const b of panel.querySelectorAll<HTMLButtonElement>('.hilo-stake')) {
      b.addEventListener('click', () => {
        this.stake = Number(b.dataset.stake);
        this.render();
      });
    }
    for (const b of panel.querySelectorAll<HTMLButtonElement>('[data-call]')) {
      b.addEventListener('click', () => this.play(b.dataset.call === 'hi' ? 'hi' : 'lo'));
    }
    panel
      .querySelector<HTMLButtonElement>('[data-close]')
      ?.addEventListener('click', () => this.close());
  }

  private play(call: 'hi' | 'lo'): void {
    const view = hiloView(this.deps.world().copper, this.stake);
    if (!view.canPlay) return;
    this.deps.world().hiloPlay(call, view.stake, freshClientSeed());
  }
}

// A fresh, unpredictable-to-the-server client seed per play: the player's
// entropy that stops the house from grinding the roll to their disadvantage.
function freshClientSeed(): string {
  const buf = new Uint8Array(16);
  crypto.getRandomValues(buf);
  return Array.from(buf, (b) => b.toString(16).padStart(2, '0')).join('');
}
