export type MinorSuit = "pentacles" | "cups" | "wands" | "swords";
export type Orientation = "upright" | "reversed";
export type CourtFace = "page" | "knight" | "queen" | "king";

export type MinorRank =
  | { kind: "number"; value: 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10 }
  | { kind: "ace" }
  | { kind: "court"; face: CourtFace };

export type CardId = string;
export type MajorId =
  | "magician"
  | "high_priestess"
  | "empress"
  | "emperor"
  | "hierophant"
  | "lovers"
  | "chariot"
  | "strength"
  | "hermit"
  | "wheel"
  | "justice"
  | "hanged_man"
  | "death"
  | "temperance"
  | "devil"
  | "tower"
  | "star"
  | "moon"
  | "sun"
  | "judgement"
  | "world";

export type PhaseId =
  | "RunInit"
  | "FloorStart"
  | "RoomReveal"
  | "RoomChoice"
  | "EngageSetup"
  | "PreResolveWindow"
  | "ResolveCommit"
  | "ResolveExecute"
  | "RoomEnd"
  | "BossStart"
  | "BossRoomLoop"
  | "FloorVictory"
  | "RunVictory"
  | "RunDefeat";

export type MinorCard = {
  id: CardId;
  suit: MinorSuit;
  rank: MinorRank;
  orientation: Orientation;
};

export type EquipmentWeapon = {
  cardId: CardId;
  value: number;
  lastHelpedDefeatValue: number | null;
  tuckedEnemyIds: CardId[];
};

export type EquipmentArmor = { cardId: CardId; value: number };
export type EquipmentSpell = { cardId: CardId; value: number };

export type PlayerBuffs = {
  cheatWeaponNextEnemyFight: boolean;
  cheatWeaponThisRoom: boolean;
};

export type PlayerState = {
  hp: number;
  maxHp: number;
  gold: number;
  fate: number;
  weapon: EquipmentWeapon | null;
  armor: EquipmentArmor | null;
  spell: EquipmentSpell | null;
  buffs: PlayerBuffs;
};

export type DeckState = {
  cards: { minors: Record<CardId, MinorCard> };
  minorDeck: CardId[];
  majorDeck: MajorId[];
};

export type WeaponRestrictionMode = "DEFAULT" | "STRICT";
export type OrderConstraintKind =
  | "NONE"
  | "LEFT_TO_RIGHT"
  | "RIGHT_TO_LEFT"
  | "SUIT_ORDER"
  | "ASC_ORDERING_VALUE";

export type OrderConstraintState = {
  kind: OrderConstraintKind;
  requiresChooseCarriedFirst: boolean;
  scopeMajorId: MajorId | null;
};

export type FloorState = {
  floorNumber: number;
  activeMajorId: MajorId;
  engagedRoomsCompleted: number;
  floorDiscard: CardId[];
  bossMode: boolean;
  bossRoomsRequired: number;
  bossRoomsCompleted: number;
  bossDeck: CardId[] | null;
};

export type RoomState = {
  slots: [CardId | null, CardId | null, CardId | null, CardId | null];
  resolvedMask: [boolean, boolean, boolean, boolean];
  carriedIndex: number | null;
  leapUsed: boolean;
  healingUsedThisRoom: boolean;
  pendingCleanses: [boolean, boolean, boolean, boolean];
  disabledFateActionsThisRoom: ("CLEANSE" | "REROLL")[];
  hangedManTriggeredThisRoom: boolean;
};

export type MajorsState = {
  claimed: MajorId[];
  attuned: MajorId[];
  spentThisFloor: MajorId[];
};

export type RngState = { algo: "xorshift32"; state: number };

export type RunState = {
  phase: PhaseId;
  runLengthTarget: 7 | 14 | 21;
  fateCap: 10;
  rng: RngState;
  player: PlayerState;
  decks: DeckState;
  floor: FloorState;
  room: RoomState;
  majors: MajorsState;
  lastRoomWasFlee: boolean;
  rules: { weaponRestrictionMode: WeaponRestrictionMode; orderConstraint: OrderConstraintState };
  debug?: {
    pendingResolution?: { slotIndex: number; cardId: CardId };
    pendingPrompt?: { kind: "ACE" | "ENEMY_FIGHT" | "SWORDS_AMBUSH_BLOCK" | "CUPS_8_10"; cardId: CardId };
  };
};

export type EngineConfig = {
  seed: number;
  runLengthTarget: 7 | 14 | 21;
};

export type LegalAction =
  | { type: "CHOOSE_FLEE" }
  | { type: "CHOOSE_ENGAGE" }
  | { type: "SELECT_CARRIED_CARD"; slotIndex: number }
  | { type: "USE_LEAP_OF_FAITH"; slotIndex: number }
  | { type: "SPEND_FATE_REROLL"; slotIndex: number }
  | { type: "SPEND_FATE_CLEANSE"; slotIndex: number }
  | { type: "SPEND_FATE_EXILE_REPLACE"; slotIndex: number }
  | { type: "SPEND_FATE_CHEAT_WEAPON" }
  | { type: "USE_SPELL_CLEANSE"; slotIndex: number }
  | { type: "USE_SPELL_REROLL"; slotIndex: number }
  | { type: "COMMIT_RESOLVE"; slotIndex: number }
  | { type: "ACE_CHOICE"; optionId: string; slotIndex?: number }
  | { type: "ENEMY_FIGHT_CHOICE"; enemyMode: "barehand" | "weapon" }
  | { type: "SWORDS_AMBUSH_BLOCK_CHOICE"; block: boolean }
  | { type: "CUPS_8_10_CHOICE"; cupsChoice: "heal" | "equipArmor" };

export type GameEvent =
  | { type: "ROOM_REVEALED"; slots: (CardId | null)[] }
  | { type: "PLAYER_HP_CHANGED"; delta: number; hp: number }
  | { type: "PLAYER_GOLD_CHANGED"; delta: number; gold: number }
  | { type: "PLAYER_FATE_CHANGED"; delta: number; fate: number }
  | { type: "CARD_BOTTOMED"; cardId: CardId }
  | { type: "CARD_EXILED"; cardId: CardId }
  | { type: "CARD_RESOLVED"; cardId: CardId; slotIndex: number }
  | { type: "EQUIP_WEAPON"; cardId: CardId; value: number }
  | { type: "EQUIP_ARMOR"; cardId: CardId; value: number }
  | { type: "EQUIP_SPELL"; cardId: CardId; value: number }
  | { type: "DISCARD_EQUIPMENT"; kind: "weapon" | "armor" | "spell"; cardId: CardId };

export type EngineResult = { nextState: RunState; events: GameEvent[] };
