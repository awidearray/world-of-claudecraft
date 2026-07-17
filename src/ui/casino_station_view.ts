// Pure view-core for the RiverBoat casino station windows: maps a station
// registry key (emitted by the sim's casinoStation event) to the i18n keys its
// window titles itself with. DOM/Three/i18n-free (returns keys, not text), so a
// Vitest drives it directly. The game leaves each add their station's title key
// here; until a leaf ships its real window, the HUD opens a placeholder modal
// that reads this title plus a shared "coming soon" body.
import type { TranslationKey } from './i18n.catalog';

const STATION_TITLE_KEYS: Record<string, TranslationKey> = {
  card_duel: 'hudChrome.casino.cardDuelTitle',
  wager_pit: 'hudChrome.casino.wagerPitTitle',
  slots: 'hudChrome.casino.slotsTitle',
  gacha: 'hudChrome.casino.gachaTitle',
  hilo: 'hudChrome.casino.hiloTitle',
  cashier: 'hudChrome.casino.cashierTitle',
};

export interface CasinoStationView {
  /** i18n key for the window title (a generic key for an unknown station). */
  titleKey: TranslationKey;
  /** i18n key for the placeholder body shown until the game leaf ships. */
  bodyKey: TranslationKey;
  /** Whether the station is a known, registered one. */
  known: boolean;
}

export function casinoStationView(station: string): CasinoStationView {
  const titleKey = STATION_TITLE_KEYS[station];
  return {
    titleKey: titleKey ?? 'hudChrome.casino.stationTitle',
    bodyKey: 'hudChrome.casino.comingSoon',
    known: titleKey !== undefined,
  };
}
