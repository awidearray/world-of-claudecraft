export interface AccountCosmetics {
  completedQuestIds: string[];
  mechChromaIds: string[];
}

// The realm's currency DISPLAY identity (launchpad phase 7): a realm with a
// registered token re-skins how the opaque copper balance is PRESENTED (symbol
// + procedural icon id). Null keeps the classic gold/silver/copper display.
// Display only: the sim's balance stays opaque copper either way; no mint,
// decimals, RPC, or price crosses this seam.
export interface RealmCurrencyIdentity {
  symbol: string;
  icon: string;
}

export interface IWorldCosmetics {
  accountCosmetics: AccountCosmetics;
  // The current realm's currency re-skin, or null for the classic display.
  // Offline worlds have no realm token, so the Sim always returns null.
  realmCurrency(): RealmCurrencyIdentity | null;
  changeSkin(skin: number, catalog?: 'class' | 'mech'): void;
  // Lock in a skin from the cosmetic skin-select event overlay. The server
  // re-validates the choice against the rank it rolled (skinEvent) and consumes
  // the event token; the offline Sim resolves it directly.
  claimEventSkin(skin: number): void;
  unequipMechChroma(chromaId: string): void;
}
