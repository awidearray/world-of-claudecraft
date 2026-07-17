// The placeholder RiverBoat casino station window: a small cold modal the HUD
// opens when a station has no real game-leaf window yet, proving the
// interaction seam (interact a croupier -> sim casinoStation event -> HUD opens
// a window) end to end. Each game leaf later registers its own opener in the
// HUD's CASINO_WINDOW_OPENERS registry, replacing this for its station. Titles
// and body render through the hudChrome.casino.* t() keys; the pure
// station-to-key mapping lives in casino_station_view.ts.
import { casinoStationView } from './casino_station_view';
import { markDialogRoot } from './dialog_root';
import { esc } from './esc';
import { t } from './i18n';

const ROOT_ID = 'casino-station-window';

// Append-only registry: a game leaf registers its station's real window opener
// here (e.g. CASINO_WINDOW_OPENERS.slots = () => openSlotsWindow()), and the HUD
// dispatches through it, falling back to the placeholder modal for any station
// with no registered opener. A leaf never edits another leaf's entry.
export const CASINO_WINDOW_OPENERS: Record<string, () => void> = {};

// Open (or re-open) the placeholder modal for `station`. Self-contained: it owns
// its overlay div, closes on the button, on Esc, and on a backdrop click, and
// restores focus to the previously focused element.
export function openCasinoStationWindow(station: string): void {
  closeCasinoStationWindow();
  const view = casinoStationView(station);
  const opener = document.activeElement as HTMLElement | null;

  const backdrop = document.createElement('div');
  backdrop.id = ROOT_ID;
  backdrop.className = 'window-backdrop casino-station-backdrop';

  const panel = document.createElement('div');
  panel.className = 'window panel casino-station-panel';
  const titleId = `${ROOT_ID}-title`;
  panel.innerHTML =
    `<h2 class="window-title" id="${titleId}">${esc(t(view.titleKey))}</h2>` +
    `<p class="casino-station-body">${esc(t(view.bodyKey))}</p>` +
    `<div class="window-actions"><button type="button" class="btn" data-close>${esc(
      t('hudChrome.casino.close'),
    )}</button></div>`;
  markDialogRoot(panel, { labelledBy: titleId, modal: true });
  backdrop.appendChild(panel);
  document.body.appendChild(backdrop);

  const close = () => {
    closeCasinoStationWindow();
    opener?.focus?.();
  };
  panel.querySelector<HTMLButtonElement>('[data-close]')?.addEventListener('click', close);
  backdrop.addEventListener('click', (e) => {
    if (e.target === backdrop) close();
  });
  panel.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      e.stopPropagation();
      close();
    }
  });
  panel.focus();
}

export function closeCasinoStationWindow(): void {
  document.getElementById(ROOT_ID)?.remove();
}
