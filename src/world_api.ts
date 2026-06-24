import { OVERHEAD_EMOTE_IDS, type ArenaCombatant, type ArenaFormat, type ArenaStanding, type CourseRunState, type Entity, type EquipSlot, type InvSlot, type MoveInput, type OverheadEmoteId, type PetMode, type PlayerClass, type QuestProgress, type QuestState, type ResourceType } from './sim/types';
import type { ResolvedAbility } from './sim/sim';
import type { TalentAllocation, SavedLoadout, Role } from './sim/content/talents';

export interface PartyMemberInfo {
  pid: number;
  name: string;
  cls: PlayerClass;
  level: number;
  hp: number;
  mhp: number;
  res: number;
  mres: number;
  rtype: ResourceType | null;
  x: number;
  z: number;
  dead: number;
  inCombat: number;
}

export interface PartyInfo {
  leader: number;
  members: PartyMemberInfo[];
}

export interface TradeOffer {
  items: InvSlot[];
  copper: number;
}

export interface TradeInfo {
  otherPid: number;
  otherName: string;
  myOffer: TradeOffer;
  theirOffer: TradeOffer;
  myAccepted: boolean;
  theirAccepted: boolean;
}

export interface DuelInfo {
  otherPid: number;
  otherName: string;
  state: 'countdown' | 'active';
}

export const OVERHEAD_EMOTES = [
  { id: 'wave', label: 'Wave' },
  { id: 'laugh', label: 'LOL' },
  { id: 'question', label: 'Bro?' },
  { id: 'cheer', label: 'Cheer' },
  { id: 'dance', label: 'Dance' },
  { id: 'point', label: 'Point' },
  { id: 'flex', label: 'Flex' },
  { id: 'salute', label: 'Salute' },
  { id: 'cry', label: 'Cry' },
  { id: 'bow', label: 'Bow' },
  { id: 'clap', label: 'Clap' },
  { id: 'roar', label: 'Roar' },
  { id: 'kneel', label: 'Kneel' },
] as const satisfies readonly { id: OverheadEmoteId; label: string }[];

export type { OverheadEmoteId };

export function isOverheadEmoteId(value: unknown): value is OverheadEmoteId {
  return typeof value === 'string' && (OVERHEAD_EMOTE_IDS as readonly string[]).includes(value);
}

// Persistent social state, mirrored from the server's SocialService. Mirrors
// server/social.ts shapes; kept here so the HUD has no server-side imports.
export type PresenceStatus = 'online' | 'combat' | 'dungeon' | 'dead';
export type GuildRank = 'leader' | 'officer' | 'member';

export interface FriendInfo {
  id: number;
  name: string;
  cls: string;
  level: number;
  realm: string;
  online: boolean;
  zone?: string;
  status?: PresenceStatus;
  // live world position of an online character, for plotting on the map
  x?: number;
  z?: number;
}

export interface GuildMemberInfo extends FriendInfo {
  rank: GuildRank;
}

export interface GuildInfo {
  id: number;
  name: string;
  rank: GuildRank;
  members: GuildMemberInfo[];
}

export interface SocialInfo {
  friends: FriendInfo[];
  blocks: { id: number; name: string }[];
  guild: GuildInfo | null;
}

export interface CharacterSearchResult {
  name: string;
  cls: string;
  level: number;
}

// One ranked row of the lifetime-XP leaderboard (Max-Level XP Overflow). Always
// computed server-side; the client only displays it.
export interface LeaderboardEntry {
  rank: number;
  name: string;
  cls: PlayerClass;
  level: number;
  virtualLevel: number;
  lifetimeXp: number;
  prestigeRank: number;
  realm?: string; // present on the global (cross-realm) home-page board
}

// One ranked row of a Skytrial time-trial leaderboard (realm-scoped, fastest
// first). Computed server-side from mount_trial_records; the client only displays.
export interface MountTrialLeaderEntry {
  rank: number;
  name: string;
  cls: string;
  level: number;
  ticks: number; // best run, integer sim ticks (÷20 = seconds)
}

// Live multi-racer (party) race state for the local player, polled by the HUD.
export interface RaceParticipant {
  pid: number;
  name: string;
  gate: number; // gates cleared so far
  total: number; // total gates in the run (checkpoints × laps)
  place: number; // finishing place once done (0 = still racing)
  done: boolean;
  dnf: boolean; // dropped out (left their mount / quit)
  me: boolean;
}
export interface RaceInfo {
  raceId: number;
  courseId: string;
  state: 'countdown' | 'active' | 'done';
  countdown: number; // whole seconds until GO (0 once racing)
  participants: RaceParticipant[]; // sorted: leaders/finishers first
}

export interface WagerMember {
  pid: number;
  name: string;
}
// Live state of the soft-currency wager lobby the player is in. The pot is
// uniform-ante × member count; `launched` flips when the race is staged (the HUD
// then hands off to RaceInfo). `anteCharterId` is a charter_<mountId> item or null.
export interface WagerInfo {
  lobbyId: number;
  hostPid: number;
  isHost: boolean;
  courseId: string;
  anteCopper: number;
  anteCharterId: string | null;
  launched: boolean;
  potCopper: number;
  potCharters: number;
  members: WagerMember[];
}

export type { ArenaFormat, ArenaCombatant, ArenaStanding };

export interface ArenaLadderEntry {
  pid: number;
  name: string;
  cls: PlayerClass;
  rating: number;
  wins: number;
  losses: number;
}

// Live 2v2 Fiesta state for the local player, polled by the HUD each frame.
export interface FiestaAugmentOffer {
  tier: 'silver' | 'gold' | 'prismatic';
  wave: number;
  choices: string[]; // augment ids; localized + described client-side
}
// One combatant's line on the scoreboard.
export interface FiestaScoreboardPlayer {
  pid: number;
  name: string;
  cls: PlayerClass;
  kills: number;
  down: boolean; // currently benched, awaiting respawn
  me: boolean;
}

// A ring power-up as the renderer/HUD sees it.
export interface FiestaPowerupView {
  id: number;
  defId: string; // POWERUPS id (localized client-side)
  x: number;
  z: number;
  state: 'spawning' | 'ready';
  frac: number; // spawning: telegraph progress 0..1; ready: lifetime remaining 0..1
  color: number; // orb/telegraph colour (hex)
}

export interface FiestaMatchInfo {
  team: 'A' | 'B';
  scoreA: number;
  scoreB: number;
  myScore: number; // my team's tally
  theirScore: number;
  scoreLimit: number;
  wave: number;
  totalWaves: number;
  // hazard ring, in WORLD coordinates so the renderer can draw it directly
  ring: { cx: number; cz: number; radius: number };
  down: boolean; // am I currently benched, awaiting respawn
  respawnIn: number; // whole seconds until I revive (0 if alive)
  augments: string[]; // augment ids I have locked in this bout
  offer: FiestaAugmentOffer | null; // a pending pick, if any
  augmentPending: number; // queued offers awaiting my next death (indicator)
  teamA: FiestaScoreboardPlayer[];
  teamB: FiestaScoreboardPlayer[];
  powerups: FiestaPowerupView[];
}

export interface ArenaInfo {
  // Backwards-compatible view of the currently selected/queued/matched bracket.
  rating: number;
  wins: number;
  losses: number;
  standings: Record<ArenaFormat, ArenaStanding>;
  format: ArenaFormat | null;
  queued: boolean;
  queueSize: number;
  // present only while in a match
  match: {
    format: ArenaFormat;
    state: 'countdown' | 'active' | 'over';
    oppName: string;
    oppClass: PlayerClass;
    oppLevel: number;
    oppPid: number;
    allies: ArenaCombatant[];
    enemies: ArenaCombatant[];
    returnIn?: number; // whole seconds left in the post-bout aftermath ('over')
    // present only for the 2v2 Fiesta party mode
    fiesta?: FiestaMatchInfo;
  } | null;
  // Backwards-compatible live ladder for the currently selected bracket.
  ladder: ArenaLadderEntry[];
  // live standings of rated players currently online, best first, by bracket
  ladders: Record<ArenaFormat, ArenaLadderEntry[]>;
}

// ---------------------------------------------------------------------------
// The World Market (the Merchant's auction house). Listings are global and
// shared by every player; collections are the per-player gold + items waiting
// to be picked up (sale proceeds, expired/returned listings).
// ---------------------------------------------------------------------------

export interface MarketListingView {
  id: number;
  sellerName: string;
  itemId: string;
  count: number;
  price: number; // total copper buyout for the whole stack
  mine: boolean; // the viewer is the seller (offer them Cancel, not Buy)
  house: boolean; // the Merchant's own standing stock
}

export interface MarketInfo {
  listings: MarketListingView[];
  collectionCopper: number; // proceeds waiting to be collected
  collectionItems: InvSlot[]; // returned/expired items waiting to be collected
  cutPct: number; // the Merchant's cut on a sale, as a percentage
  maxListings: number; // per-seller active-listing cap
  myListingCount: number; // how many active listings the viewer already has
}

export interface AccountCosmetics {
  completedQuestIds: string[];
  mechChromaIds: string[];
}

// The surface the renderer + HUD need from a game world. The offline `Sim`
// satisfies this structurally; the online `ClientWorld` implements it by
// mirroring server snapshots and sending commands over the socket.
export interface IWorld {
  cfg: { seed: number; playerClass: PlayerClass };
  entities: Map<number, Entity>;
  playerId: number;
  player: Entity;
  moveInput: MoveInput;
  inventory: InvSlot[];
  vendorBuyback: InvSlot[];
  equipment: Partial<Record<EquipSlot, string>>;
  accountCosmetics: AccountCosmetics;
  copper: number;
  xp: number;
  // Post-cap progression (Max-Level XP Overflow). All server-authoritative;
  // the client renders these as-is and derives virtual level from lifetimeXp.
  lifetimeXp: number;
  prestigeRank: number;
  unlockedMilestones: string[];
  // Classic Rested XP pool (inn-rested kill-XP bonus); 0 when not rested.
  restedXp: number;
  known: ResolvedAbility[];
  questLog: Map<string, QuestProgress>;
  questsDone: Set<string>;
  questState(questId: string): QuestState;
  castAbility(abilityId: string): void;
  castAbilityBySlot(slot: number): void;
  targetEntity(id: number | null): void;
  tabTarget(): void;
  targetNearestFriendly(): void;
  friendlyTabTarget(): void;
  startAutoAttack(): void;
  stopAutoAttack(): void;
  interact(): void;
  lootCorpse(id: number): void;
  pickUpObject(id: number): void;
  acceptQuest(questId: string): void;
  turnInQuest(questId: string): void;
  abandonQuest(questId: string): void;
  equipItem(itemId: string): void;
  useItem(itemId: string): void;
  discardItem(itemId: string, count?: number): void;
  buyItem(npcId: number, itemId: string): void;
  sellItem(itemId: string, count?: number): void;
  buyBackItem(itemId: string): void;
  changeSkin(skin: number, catalog?: 'class' | 'mech'): void;
  // Lock in a skin from the cosmetic skin-select event overlay. The server
  // re-validates the choice against the rank it rolled (skinEvent) and consumes
  // the event token; the offline Sim resolves it directly.
  claimEventSkin(skin: number): void;
  unequipMechChroma(chromaId: string): void;
  // $WOC holder travel mounts. Eligibility (`player.mountTier`, 0-11) and the
  // active steed (`player.mountId`) are read directly off the player Entity —
  // both are server-set and ride the wire like `skin`/`holderTier`. `mountCast`
  // is the in-progress summon (off-entity, session/self-only) for the cast bar.
  // summonMount begins the cast (or instantly swaps while already mounted);
  // dismissMount throws you off. The server re-validates every summon against the
  // wallet's live balance, so a client cannot ride a mount it doesn't hold.
  mountCast: { id: string; remaining: number; total: number } | null;
  summonMount(mountId: string): void;
  dismissMount(): void;
  // Mount-activity course runs (hoop / time-trial / race). `courseRun` is the
  // server-authoritative in-progress run (null when idle); the HUD draws the
  // timer/gate overlay from it. startCourse begins one (server gates flyer-only
  // + eligibility); abortCourse bails.
  courseRun: CourseRunState | null;
  startCourse(courseId: string): void;
  abortCourse(): void;
  // Skytrial best times. `mountTrialBests` is this character's best run per course
  // (ticks), for the launcher + "new best" feedback; the realm leaderboard is
  // fetched on demand (server-computed from mount_trial_records).
  mountTrialBests: Record<string, number>;
  mountTrialLeaderboard(trackId: string): Promise<MountTrialLeaderEntry[]>;
  // Multi-racer races: the leader starts one for their party (or solo); placement
  // is by finish order on a synchronized countdown→GO. `raceInfo` is the live
  // state for the HUD panel (null when not in a race).
  raceInfo: RaceInfo | null;
  startRace(courseId: string): void;
  // Mount Charters — the earned (non-$WOC) ownership track. `earnedMounts` are
  // mount ids permanently owned via a redeemed Charter (summonable regardless of
  // holdings); `mintCharter` strikes a tradeable deed for a mount the wallet
  // currently covers. Redeeming a Charter goes through the normal useItem path.
  earnedMounts: string[];
  mintCharter(mountId: string): void;
  // Soft-currency Wager Races — stake in-game gold (+ an optional Mount Charter)
  // on a PvP race; winner takes the pot. `wagerInfo` is the live lobby/pot state
  // (null when not in a wager). `proposeWagerRace` opens a staked lobby (charges
  // the host); others `wagerJoin`/`wagerDecline` an invite (join is the only point
  // they pay); the host `launchWagerRace`s once ≥2 have staked; anyone can
  // `wagerLeave` before launch (refunded). NO real money / $WOC.
  wagerInfo: WagerInfo | null;
  proposeWagerRace(courseId: string, anteCopper: number, anteCharterId: string | null): void;
  wagerJoin(): void;
  wagerDecline(): void;
  wagerLeave(): void;
  launchWagerRace(): void;
  releaseSpirit(): void;
  chat(text: string): void;
  playEmote(emoteId: OverheadEmoteId): void;
  abandonPet(): void;
  renamePet(name: string): void;
  revivePet(): void;
  petAttack(): void;
  petTaunt(): void;
  feedPet(itemId: string): void;
  healPet(): void;
  setPetMode(mode: PetMode): void;
  // social systems
  partyInfo: PartyInfo | null;
  tradeInfo: TradeInfo | null;
  duelInfo: DuelInfo | null;
  arenaInfo: ArenaInfo | null;
  marketInfo: MarketInfo | null;
  partyInvite(targetPid: number): void;
  partyAccept(): void;
  partyDecline(): void;
  partyLeave(): void;
  partyKick(targetPid: number): void;
  // raid/target markers (party-scoped): markerId 0..7, null = no mark
  markerFor(entityId: number): number | null;
  setMarker(entityId: number, markerId: number): void;
  clearMarker(entityId: number): void;
  tradeRequest(targetPid: number): void;
  tradeAccept(): void;
  tradeSetOffer(items: InvSlot[], copper: number): void;
  tradeConfirm(): void;
  tradeCancel(): void;
  duelRequest(targetPid: number): void;
  duelAccept(): void;
  duelDecline(): void;
  // the realm (world/shard) this character lives on; '' in offline play
  realm: string;
  // persistent social: friends, ignore/block, guilds (online play only)
  socialInfo: SocialInfo | null;
  friendAdd(name: string): void;
  friendRemove(name: string): void;
  blockAdd(name: string): void;
  blockRemove(name: string): void;
  guildCreate(name: string): void;
  guildInvite(name: string): void;
  guildAccept(): void;
  guildDecline(): void;
  guildLeave(): void;
  guildKick(name: string): void;
  guildPromote(name: string): void;
  guildDemote(name: string): void;
  guildTransfer(name: string): void;
  guildDisband(): void;
  // realm-scoped username typeahead for friend/ignore/guild search
  searchCharacters(query: string): Promise<CharacterSearchResult[]>;
  arenaQueueJoin(format?: ArenaFormat): void;
  arenaQueueLeave(): void;
  // 2v2 Fiesta: lock in one of the augments currently on offer
  arenaAugmentPick(augmentId: string): void;
  // World Market
  marketList(itemId: string, count: number, price: number): void;
  marketBuy(listingId: number): void;
  marketCancel(listingId: number): void;
  marketCollect(): void;
  enterDungeon(dungeonId: string): void;
  leaveDungeon(): void;
  // Post-cap progression: the realm-scoped lifetime-XP leaderboard, and the
  // opt-in cosmetic prestige action.
  leaderboard(): Promise<LeaderboardEntry[]>;
  prestige(): void;
  // Talents & Specializations. State is server-authoritative; the client stages
  // edits locally and commits via applyTalents (the server re-validates).
  talents: TalentAllocation;
  talentSpec: string | null;
  talentRole: Role | null;
  loadouts: SavedLoadout[];
  activeLoadout: number;
  talentPoints(): { total: number; spent: number };
  applyTalents(alloc: TalentAllocation): void;
  respec(): void;
  setSpec(specId: string | null): void;
  saveLoadout(name: string, bar: (string | null)[], alloc?: TalentAllocation): void;
  switchLoadout(index: number): void;
  deleteLoadout(index: number): void;
}
