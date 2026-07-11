import type { EquipSlot, InvSlot } from '../sim/types';

// In-world currency display identity (launchpad phase 7). Pure DISPLAY data, so
// the HUD can re-skin the classic gold/silver/copper coins as a per-realm token
// WITHOUT the deterministic sim ever learning about a mint. The sim keeps its
// OPAQUE numeric `copper` balance below; nothing here is a mint, a decimal
// count, an RPC, or a price. `realmToken` false (the default and the canonical
// realm) means the classic coin display; true means the flat token amount with
// its symbol. This is types-as-data on the seam, never a t() key.
export interface CurrencyIdentity {
  symbol: string; // the ticker shown when realmToken is true (e.g. MOON)
  icon: string; // a short procedural-icon id, or '' to derive from the symbol
  realmToken: boolean; // false: classic coins; true: flat token amount + symbol
}

// The default: the classic coin display. The offline single-player Sim always
// uses this (it has no realm token).
export const CLASSIC_CURRENCY: CurrencyIdentity = { symbol: 'WOC', icon: '', realmToken: false };

export interface IWorldInventory {
  inventory: InvSlot[];
  // The 4 equippable bag sockets (kind:'bag' item ids, null = empty socket).
  bags: (string | null)[];
  // Total pooled slot budget: the implicit 16-slot backpack plus every
  // equipped bag's bagSlots (see src/sim/bags.ts). Used slots is inventory.length.
  bagCapacity: number;
  vendorBuyback: InvSlot[];
  equipment: Partial<Record<EquipSlot, string>>;
  copper: number;
  // The realm's currency display identity (phase 7). Display-only: render/ui
  // read it to re-skin the money display; the sim never reads it for logic.
  readonly currencyIdentity: CurrencyIdentity;
  equipItem(itemId: string): void;
  unequipItem(slot: EquipSlot): void;
  /** Equip a bag item into a socket (first empty when omitted; swaps in place). */
  equipBag(itemId: string, socket?: number): void;
  /** Return the bag in `socket` to the inventory (refused when items would not fit). */
  unequipBag(socket: number): void;
  useItem(itemId: string): void;
  discardItem(itemId: string, count?: number): void;
  buyItem(npcId: number, itemId: string): void;
  sellItem(itemId: string, count?: number): void;
  // Sell every gray (poor-quality) item in the bags at once while a vendor is open.
  // Quest items and anything flagged noVendorSell are left untouched.
  sellAllJunk(): void;
  buyBackItem(itemId: string): void;
}
