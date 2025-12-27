import { Xorshift32 } from "./rng/xorshift32.js";
import type {
  CardId,
  EngineConfig,
  EngineResult,
  GameEvent,
  LegalAction,
  MajorId,
  MinorCard,
  MinorRank,
  MinorSuit,
  Orientation,
  RunState
} from "./types.js";
import {
  applyArmorIfAny,
  computeEffectiveOrientation,
  computeEnemyValue,
  computeMinorNumericValue,
  isCourt,
  isNumbered
} from "./rules.js";

const ALL_MAJORS: MajorId[] = [
  "magician",
  "high_priestess",
  "empress",
  "emperor",
  "hierophant",
  "lovers",
  "chariot",
  "strength",
  "hermit",
  "wheel",
  "justice",
  "hanged_man",
  "death",
  "temperance",
  "devil",
  "tower",
  "star",
  "moon",
  "sun",
  "judgement",
  "world"
];

function fisherYatesShuffle<T>(arr: T[], rng: Xorshift32) {
  for (let i = arr.length - 1; i > 0; i -= 1) {
    const j = rng.nextUint32() % (i + 1);
    const tmp = arr[i];
    arr[i] = arr[j]!;
    arr[j] = tmp!;
  }
}

function buildMinorCards(rng: Xorshift32): { cards: Record<CardId, MinorCard>; deck: CardId[] } {
  const cards: Record<CardId, MinorCard> = {};
  const deck: CardId[] = [];

  const suits: MinorSuit[] = ["pentacles", "cups", "wands", "swords"];
  const numberValues: Array<2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10> = [2, 3, 4, 5, 6, 7, 8, 9, 10];
  const courtFaces = ["page", "knight", "queen", "king"] as const;

  for (const suit of suits) {
    for (const v of numberValues) {
      const id = `${suit}_${v}`;
      const orientation: Orientation = (rng.nextUint32() & 1) === 1 ? "reversed" : "upright";
      const rank: MinorRank = { kind: "number", value: v };
      cards[id] = { id, suit, rank, orientation };
      deck.push(id);
    }
    {
      const id = `${suit}_ace`;
      const orientation: Orientation = (rng.nextUint32() & 1) === 1 ? "reversed" : "upright";
      const rank: MinorRank = { kind: "ace" };
      cards[id] = { id, suit, rank, orientation };
      deck.push(id);
    }
    for (const face of courtFaces) {
      const id = `${suit}_${face}`;
      const orientation: Orientation = (rng.nextUint32() & 1) === 1 ? "reversed" : "upright";
      const rank: MinorRank = { kind: "court", face };
      cards[id] = { id, suit, rank, orientation };
      deck.push(id);
    }
  }

  fisherYatesShuffle(deck, rng);
  return { cards, deck };
}

function buildInitialRoom(carried: { slotIndex: number; cardId: CardId } | null) {
  const slots: [CardId | null, CardId | null, CardId | null, CardId | null] = [null, null, null, null];
  if (carried) slots[carried.slotIndex] = carried.cardId;
  return {
    slots,
    resolvedMask: [false, false, false, false] as [boolean, boolean, boolean, boolean],
    carriedIndex: carried ? carried.slotIndex : null,
    leapUsed: false,
    healingUsedThisRoom: false,
    pendingCleanses: [false, false, false, false] as [boolean, boolean, boolean, boolean],
    disabledFateActionsThisRoom: [],
    hangedManTriggeredThisRoom: false
  };
}

function cloneState(state: RunState): RunState {
  return structuredClone(state);
}

function clamp(n: number, min: number, max: number) {
  return Math.max(min, Math.min(max, n));
}

function addFate(state: RunState, delta: number, events: GameEvent[]) {
  const next = clamp(state.player.fate + delta, 0, state.fateCap);
  const actual = next - state.player.fate;
  if (actual !== 0) {
    state.player.fate = next;
    events.push({ type: "PLAYER_FATE_CHANGED", delta: actual, fate: next });
  }
}

function addGold(state: RunState, delta: number, events: GameEvent[]) {
  const next = clamp(state.player.gold + delta, 0, 9999);
  const actual = next - state.player.gold;
  if (actual !== 0) {
    state.player.gold = next;
    events.push({ type: "PLAYER_GOLD_CHANGED", delta: actual, gold: next });
  }
}

function applyDamage(state: RunState, amount: number, events: GameEvent[]) {
  const reduced = applyArmorIfAny(state, amount, events);
  if (reduced <= 0) return;
  const next = clamp(state.player.hp - reduced, 0, 999);
  const actual = next - state.player.hp;
  if (actual !== 0) {
    state.player.hp = next;
    events.push({ type: "PLAYER_HP_CHANGED", delta: actual, hp: next });
  }
}

function applyHeal(state: RunState, amount: number, events: GameEvent[]) {
  if (amount <= 0) return;
  if (state.room.healingUsedThisRoom) return;
  const next = clamp(state.player.hp + amount, 0, state.player.maxHp);
  const actual = next - state.player.hp;
  if (actual <= 0) return;
  state.player.hp = next;
  state.room.healingUsedThisRoom = true;
  events.push({ type: "PLAYER_HP_CHANGED", delta: actual, hp: next });
}

function drawFromMinorDeck(state: RunState): CardId {
  const id = state.decks.minorDeck.shift();
  if (!id) throw new Error("Minor deck is empty");
  return id;
}

function bottomToMinorDeck(state: RunState, cardId: CardId, events: GameEvent[]) {
  state.decks.minorDeck.push(cardId);
  events.push({ type: "CARD_BOTTOMED", cardId });
}

function exileToFloorDiscard(state: RunState, cardId: CardId, events: GameEvent[]) {
  state.floor.floorDiscard.push(cardId);
  events.push({ type: "CARD_EXILED", cardId });
}

function fillRoomToFour(state: RunState, events: GameEvent[]) {
  for (let i = 0; i < 4; i += 1) {
    if (state.room.slots[i] === null) {
      state.room.slots[i] = drawFromMinorDeck(state);
    }
  }
  state.phase = "RoomChoice";
  events.push({ type: "ROOM_REVEALED", slots: [...state.room.slots] });
}

function resolvedCount(state: RunState) {
  return state.room.resolvedMask.filter(Boolean).length;
}

function getCard(state: RunState, cardId: CardId) {
  const c = state.decks.cards.minors[cardId];
  if (!c) throw new Error(`Unknown cardId: ${cardId}`);
  return c;
}

function canUseWeaponAgainstEnemy(state: RunState, enemyValue: number): boolean {
  const weapon = state.player.weapon;
  if (!weapon) return false;
  if (state.player.buffs.cheatWeaponNextEnemyFight || state.player.buffs.cheatWeaponThisRoom) return true;
  if (weapon.lastHelpedDefeatValue === null) return true;
  if (state.rules.weaponRestrictionMode === "STRICT") return enemyValue < weapon.lastHelpedDefeatValue;
  return enemyValue <= weapon.lastHelpedDefeatValue;
}

function clearPendingResolution(state: RunState) {
  if (!state.debug) return;
  delete state.debug.pendingResolution;
  delete state.debug.pendingPrompt;
}

function completeResolvedCard(
  state: RunState,
  events: GameEvent[],
  slotIndex: number,
  cardId: CardId,
  effectiveOrientation: Orientation,
  discardToFloor: boolean
) {
  state.room.resolvedMask[slotIndex] = true;
  state.room.slots[slotIndex] = null;
  state.room.pendingCleanses[slotIndex] = false;
  if (discardToFloor) state.floor.floorDiscard.push(cardId);
  events.push({ type: "CARD_RESOLVED", cardId, slotIndex });
  if (effectiveOrientation === "reversed") addFate(state, 1, events);

  clearPendingResolution(state);

  if (state.player.hp <= 0) {
    state.phase = "RunDefeat";
    return;
  }

  if (resolvedCount(state) >= 3) state.phase = "RoomEnd";
  else state.phase = "PreResolveWindow";
}

function resolvePendingNoChoice(state: RunState, events: GameEvent[]): boolean {
  const pending = state.debug?.pendingResolution;
  if (!pending) return false;

  const slotIndex = pending.slotIndex;
  const cardId = state.room.slots[slotIndex];
  if (!cardId || cardId !== pending.cardId) throw new Error("Pending resolution card mismatch");

  const card = getCard(state, cardId);
  const effective = computeEffectiveOrientation(state, slotIndex, card);

  // Aces always prompt.
  if (card.rank.kind === "ace") return false;

  // Courts: if weapon is usable, player chooses; otherwise forced barehand.
  if (isCourt(card)) {
    const enemyVal = computeEnemyValue(card, effective);
    const canWeapon = state.player.weapon ? canUseWeaponAgainstEnemy(state, enemyVal) : false;
    if (canWeapon) return false;
    applyDamage(state, enemyVal, events);
    completeResolvedCard(state, events, slotIndex, cardId, effective, true);
    return true;
  }

  if (card.rank.kind !== "number") throw new Error("Unexpected non-number non-ace minor");
  const v = computeMinorNumericValue(card.rank);

  if (card.suit === "cups" && effective === "upright" && v >= 8) return false; // player choice
  if (card.suit === "swords" && effective === "reversed" && state.player.weapon) return false; // player choice

  if (card.suit === "pentacles") {
    if (effective === "upright") addGold(state, v, events);
    else {
      const lose = Math.min(state.player.gold, v);
      addGold(state, -lose, events);
      const remainder = v - lose;
      if (remainder > 0) applyDamage(state, remainder, events);
    }
    completeResolvedCard(state, events, slotIndex, cardId, effective, true);
    return true;
  }

  if (card.suit === "cups") {
    if (effective === "upright") applyHeal(state, v, events);
    else {
      const prevArmor = state.player.armor;
      state.player.armor = null;
      applyDamage(state, v, events);
      state.player.armor = prevArmor;
    }
    completeResolvedCard(state, events, slotIndex, cardId, effective, true);
    return true;
  }

  if (card.suit === "wands") {
    if (effective === "upright") {
      state.player.spell = { cardId, value: v };
      events.push({ type: "EQUIP_SPELL", cardId, value: v });
      completeResolvedCard(state, events, slotIndex, cardId, effective, false);
    } else {
      if (state.player.spell) {
        const discarded = state.player.spell.cardId;
        state.player.spell = null;
        exileToFloorDiscard(state, discarded, events);
        events.push({ type: "DISCARD_EQUIPMENT", kind: "spell", cardId: discarded });
      } else {
        applyDamage(state, 2, events);
      }
      completeResolvedCard(state, events, slotIndex, cardId, effective, true);
    }
    return true;
  }

  if (card.suit === "swords") {
    if (effective === "upright") {
      const prev = state.player.weapon;
      if (prev) {
        exileToFloorDiscard(state, prev.cardId, events);
        events.push({ type: "DISCARD_EQUIPMENT", kind: "weapon", cardId: prev.cardId });
      }
      state.player.weapon = { cardId, value: v, lastHelpedDefeatValue: null, tuckedEnemyIds: [] };
      events.push({ type: "EQUIP_WEAPON", cardId, value: v });
      completeResolvedCard(state, events, slotIndex, cardId, effective, false);
    } else {
      // No weapon: forced ambush damage.
      applyDamage(state, v, events);
      completeResolvedCard(state, events, slotIndex, cardId, effective, true);
    }
    return true;
  }

  throw new Error("Unhandled suit");
}

function computeAllowedCommitSlots(state: RunState): number[] {
  const occupied = [0, 1, 2, 3].filter((i) => state.room.slots[i] !== null && !state.room.resolvedMask[i]);
  if (occupied.length === 0) return [];

  const carriedIndex = state.room.carriedIndex;
  const constraint = state.rules.orderConstraint.kind;
  const requiresChooseCarriedFirst = state.rules.orderConstraint.requiresChooseCarriedFirst;

  if (requiresChooseCarriedFirst && carriedIndex === null) return [];
  if (constraint === "NONE") return occupied;

  const nonCarried = occupied.filter((i) => i !== carriedIndex);
  if (nonCarried.length === 0) return [];

  if (constraint === "LEFT_TO_RIGHT") return [Math.min(...nonCarried)];
  if (constraint === "RIGHT_TO_LEFT") return [Math.max(...nonCarried)];

  if (constraint === "SUIT_ORDER") {
    const suitOrder: Record<MinorSuit, number> = { cups: 0, pentacles: 1, swords: 2, wands: 3 };
    const sorted = nonCarried
      .map((i) => ({ i, suit: getCard(state, state.room.slots[i]!).suit }))
      .sort((a, b) => suitOrder[a.suit] - suitOrder[b.suit] || a.i - b.i);
    return [sorted[0]!.i];
  }

  // ASC_ORDERING_VALUE
  const sorted = nonCarried
    .map((i) => {
      const card = getCard(state, state.room.slots[i]!);
      const eff = computeEffectiveOrientation(state, i, card);
      let orderingValue: number;
      if (card.rank.kind === "court") orderingValue = computeEnemyValue(card, eff);
      else if (card.rank.kind === "ace") orderingValue = 1;
      else orderingValue = computeMinorNumericValue(card.rank);
      return { i, orderingValue };
    })
    .sort((a, b) => a.orderingValue - b.orderingValue || a.i - b.i);
  return [sorted[0]!.i];
}

function autoAdvance(state: RunState, events: GameEvent[]) {
  while (true) {
    if (state.phase === "RunInit") {
      state.phase = "RoomReveal";
      continue;
    }
    if (state.phase === "RoomReveal") {
      fillRoomToFour(state, events);
      break;
    }
    if (state.phase === "EngageSetup") {
      const requiresChooseCarriedFirst = state.rules.orderConstraint.requiresChooseCarriedFirst;
      if (requiresChooseCarriedFirst && state.room.carriedIndex === null) break;
      state.phase = "PreResolveWindow";
      continue;
    }
    if (state.phase === "ResolveCommit") {
      state.phase = "ResolveExecute";
      continue;
    }
    if (state.phase === "ResolveExecute") {
      if (!state.debug?.pendingResolution) break;
      const progressed = resolvePendingNoChoice(state, events);
      if (progressed) continue;
      break;
    }
    if (state.phase === "RoomEnd") {
      const remainingIndex = [0, 1, 2, 3].find((i) => state.room.slots[i] !== null);
      if (remainingIndex === undefined) throw new Error("RoomEnd with no remaining carried card");
      const carriedCardId = state.room.slots[remainingIndex]!;
      state.room = buildInitialRoom({ slotIndex: remainingIndex, cardId: carriedCardId });
      state.phase = "RoomReveal";
      continue;
    }
    break;
  }
}

export function createRun(config: EngineConfig): RunState {
  const rng = new Xorshift32(config.seed);
  const { cards, deck } = buildMinorCards(rng);
  const majorDeck = [...ALL_MAJORS];
  fisherYatesShuffle(majorDeck, rng);

  const state: RunState = {
    phase: "RunInit",
    runLengthTarget: config.runLengthTarget,
    fateCap: 10,
    rng: { algo: "xorshift32", state: rng.state },
    player: {
      hp: 20,
      maxHp: 20,
      gold: 0,
      fate: 0,
      weapon: null,
      armor: null,
      spell: null,
      buffs: { cheatWeaponNextEnemyFight: false, cheatWeaponThisRoom: false }
    },
    decks: { cards: { minors: cards }, minorDeck: deck, majorDeck },
    floor: {
      floorNumber: 1,
      activeMajorId: majorDeck[0] ?? "magician",
      engagedRoomsCompleted: 0,
      floorDiscard: [],
      bossMode: false,
      bossRoomsRequired: 0,
      bossRoomsCompleted: 0,
      bossDeck: null
    },
    room: buildInitialRoom(null),
    majors: { claimed: [], attuned: [], spentThisFloor: [] },
    lastRoomWasFlee: false,
    rules: {
      weaponRestrictionMode: "DEFAULT",
      orderConstraint: { kind: "NONE", requiresChooseCarriedFirst: false, scopeMajorId: null }
    }
  };

  state.rng.state = rng.state;
  const events: GameEvent[] = [];
  autoAdvance(state, events);
  return state;
}

export function getLegalActions(state: RunState): LegalAction[] {
  if (state.phase === "RunDefeat" || state.phase === "RunVictory") return [];
  if (state.player.hp <= 0) return [];

  if (state.phase === "RoomChoice") {
    const out: LegalAction[] = [{ type: "CHOOSE_ENGAGE" }];
    if (!state.lastRoomWasFlee) out.push({ type: "CHOOSE_FLEE" });
    return out;
  }

  if (state.phase === "EngageSetup") {
    if (state.rules.orderConstraint.requiresChooseCarriedFirst && state.room.carriedIndex === null) {
      return [0, 1, 2, 3]
        .filter((i) => state.room.slots[i] !== null)
        .map((slotIndex) => ({ type: "SELECT_CARRIED_CARD", slotIndex }));
    }
    return [];
  }

  if (state.phase === "PreResolveWindow") {
    const actions: LegalAction[] = [];
    const occupiedSlots = [0, 1, 2, 3].filter((i) => state.room.slots[i] !== null && !state.room.resolvedMask[i]);

    if (!state.room.leapUsed) {
      for (const slotIndex of occupiedSlots) actions.push({ type: "USE_LEAP_OF_FAITH", slotIndex });
    }

    if (state.player.fate >= 1 && !state.room.disabledFateActionsThisRoom.includes("REROLL")) {
      for (const slotIndex of occupiedSlots) actions.push({ type: "SPEND_FATE_REROLL", slotIndex });
    }

    if (state.player.fate >= 1 && !state.room.disabledFateActionsThisRoom.includes("CLEANSE")) {
      for (const slotIndex of occupiedSlots) {
        const card = getCard(state, state.room.slots[slotIndex]!);
        const eff = computeEffectiveOrientation(state, slotIndex, card);
        if (eff === "reversed") actions.push({ type: "SPEND_FATE_CLEANSE", slotIndex });
      }
    }

    if (state.player.fate >= 2) {
      for (const slotIndex of occupiedSlots) actions.push({ type: "SPEND_FATE_EXILE_REPLACE", slotIndex });
      actions.push({ type: "SPEND_FATE_CHEAT_WEAPON" });
    }

    if (state.player.spell) {
      for (const slotIndex of occupiedSlots) actions.push({ type: "USE_SPELL_CLEANSE", slotIndex });
      for (const slotIndex of occupiedSlots) actions.push({ type: "USE_SPELL_REROLL", slotIndex });
    }

    for (const slotIndex of computeAllowedCommitSlots(state)) actions.push({ type: "COMMIT_RESOLVE", slotIndex });
    return actions;
  }

  if (state.phase === "ResolveExecute") {
    const pending = state.debug?.pendingResolution;
    if (!pending) return [];
    const card = getCard(state, pending.cardId);
    const effective = computeEffectiveOrientation(state, pending.slotIndex, card);

    // Ace prompts
    if (card.rank.kind === "ace") {
      if (card.suit === "pentacles") {
        return [
          { type: "ACE_CHOICE", optionId: "pay5_heal5" },
          { type: "ACE_CHOICE", optionId: "gain5_take3" }
        ];
      }
      if (card.suit === "cups") {
        const acts: LegalAction[] = [{ type: "ACE_CHOICE", optionId: "heal_to_full" }];
        for (const slotIndex of [0, 1, 2, 3]) {
          const id = state.room.slots[slotIndex];
          if (!id) continue;
          const target = getCard(state, id);
          const eff = computeEffectiveOrientation(state, slotIndex, target);
          if (eff === "reversed") acts.push({ type: "ACE_CHOICE", optionId: "cleanse_free", slotIndex });
        }
        return acts;
      }
      if (card.suit === "wands") {
        const acts: LegalAction[] = [];
        for (const slotIndex of [0, 1, 2, 3]) {
          if (state.room.slots[slotIndex] === null) continue;
          acts.push({ type: "ACE_CHOICE", optionId: "exile_replace_free", slotIndex });
          acts.push({ type: "ACE_CHOICE", optionId: "reroll_free", slotIndex });
        }
        return acts;
      }
      if (card.suit === "swords") {
        const acts: LegalAction[] = [{ type: "ACE_CHOICE", optionId: "cheat_weapon_free" }];
        for (const slotIndex of [0, 1, 2, 3]) {
          if (state.room.slots[slotIndex] === null) continue;
          acts.push({ type: "ACE_CHOICE", optionId: "reroll_free", slotIndex });
        }
        return acts;
      }
    }

    // Reversed swords ambush prompt
    if (card.suit === "swords" && isNumbered(card.rank) && effective === "reversed" && state.player.weapon) {
      return [{ type: "SWORDS_AMBUSH_BLOCK_CHOICE", block: true }, { type: "SWORDS_AMBUSH_BLOCK_CHOICE", block: false }];
    }

    // Cups 8-10 choice prompt
    if (card.suit === "cups" && isNumbered(card.rank) && effective === "upright") {
      const v = computeMinorNumericValue(card.rank);
      if (v >= 8) return [{ type: "CUPS_8_10_CHOICE", cupsChoice: "heal" }, { type: "CUPS_8_10_CHOICE", cupsChoice: "equipArmor" }];
    }

    // Enemy fight prompt
    if (isCourt(card)) {
      const enemyVal = computeEnemyValue(card, effective);
      const canWeapon = canUseWeaponAgainstEnemy(state, enemyVal);
      if (state.player.weapon && canWeapon) {
        return [
          { type: "ENEMY_FIGHT_CHOICE", enemyMode: "barehand" },
          { type: "ENEMY_FIGHT_CHOICE", enemyMode: "weapon" }
        ];
      }
      // Forced barehand (no decision): auto-resolved by engine.
      return [];
    }

    return [];
  }

  return [];
}

export function applyAction(state: RunState, action: LegalAction): EngineResult {
  const nextState = cloneState(state);
  const events: GameEvent[] = [];

  if (nextState.player.hp <= 0) return { nextState: { ...nextState, phase: "RunDefeat" }, events };

  switch (action.type) {
    case "CHOOSE_FLEE": {
      if (nextState.phase !== "RoomChoice") throw new Error("CHOOSE_FLEE not allowed in this phase");
      if (nextState.lastRoomWasFlee) throw new Error("Cannot flee two rooms in a row");

      for (let i = 0; i < 4; i += 1) {
        const id = nextState.room.slots[i];
        if (!id) continue;
        bottomToMinorDeck(nextState, id, events);
        nextState.room.slots[i] = null;
        nextState.room.pendingCleanses[i] = false;
      }

      nextState.lastRoomWasFlee = true;
      nextState.room = buildInitialRoom(null);
      nextState.phase = "RoomReveal";
      autoAdvance(nextState, events);
      return { nextState, events };
    }

    case "CHOOSE_ENGAGE": {
      if (nextState.phase !== "RoomChoice") throw new Error("CHOOSE_ENGAGE not allowed in this phase");
      nextState.lastRoomWasFlee = false;
      nextState.phase = "EngageSetup";
      autoAdvance(nextState, events);
      return { nextState, events };
    }

    case "SELECT_CARRIED_CARD": {
      if (nextState.phase !== "EngageSetup") throw new Error("SELECT_CARRIED_CARD not allowed in this phase");
      if (!nextState.rules.orderConstraint.requiresChooseCarriedFirst) throw new Error("No carried selection required");
      if (nextState.room.slots[action.slotIndex] === null) throw new Error("Slot is empty");
      nextState.room.carriedIndex = action.slotIndex;
      autoAdvance(nextState, events);
      return { nextState, events };
    }

    case "USE_LEAP_OF_FAITH": {
      if (nextState.phase !== "PreResolveWindow") throw new Error("USE_LEAP_OF_FAITH not allowed in this phase");
      if (nextState.room.leapUsed) throw new Error("Leap already used this room");
      const cardId = nextState.room.slots[action.slotIndex];
      if (!cardId) throw new Error("Slot is empty");
      const card = getCard(nextState, cardId);
      card.orientation = card.orientation === "upright" ? "reversed" : "upright";
      nextState.room.leapUsed = true;
      if (card.orientation === "reversed") addFate(nextState, 2, events);
      else applyDamage(nextState, 2, events);
      return { nextState, events };
    }

    case "SPEND_FATE_REROLL": {
      if (nextState.phase !== "PreResolveWindow") throw new Error("SPEND_FATE_REROLL not allowed in this phase");
      if (nextState.room.disabledFateActionsThisRoom.includes("REROLL")) throw new Error("Fate reroll disabled this room");
      if (nextState.player.fate < 1) throw new Error("Not enough Fate");
      const cardId = nextState.room.slots[action.slotIndex];
      if (!cardId) throw new Error("Slot is empty");
      addFate(nextState, -1, events);
      bottomToMinorDeck(nextState, cardId, events);
      nextState.room.pendingCleanses[action.slotIndex] = false;
      nextState.room.slots[action.slotIndex] = drawFromMinorDeck(nextState);
      return { nextState, events };
    }

    case "SPEND_FATE_CLEANSE": {
      if (nextState.phase !== "PreResolveWindow") throw new Error("SPEND_FATE_CLEANSE not allowed in this phase");
      if (nextState.room.disabledFateActionsThisRoom.includes("CLEANSE")) throw new Error("Fate cleanse disabled this room");
      if (nextState.player.fate < 1) throw new Error("Not enough Fate");
      const cardId = nextState.room.slots[action.slotIndex];
      if (!cardId) throw new Error("Slot is empty");
      const card = getCard(nextState, cardId);
      const eff = computeEffectiveOrientation(nextState, action.slotIndex, card);
      if (eff !== "reversed") throw new Error("Can only cleanse effective-reversed cards");
      addFate(nextState, -1, events);
      nextState.room.pendingCleanses[action.slotIndex] = true;
      return { nextState, events };
    }

    case "SPEND_FATE_EXILE_REPLACE": {
      if (nextState.phase !== "PreResolveWindow") throw new Error("SPEND_FATE_EXILE_REPLACE not allowed in this phase");
      if (nextState.player.fate < 2) throw new Error("Not enough Fate");
      const cardId = nextState.room.slots[action.slotIndex];
      if (!cardId) throw new Error("Slot is empty");
      addFate(nextState, -2, events);
      exileToFloorDiscard(nextState, cardId, events);
      nextState.room.pendingCleanses[action.slotIndex] = false;
      nextState.room.slots[action.slotIndex] = drawFromMinorDeck(nextState);
      return { nextState, events };
    }

    case "SPEND_FATE_CHEAT_WEAPON": {
      if (nextState.phase !== "PreResolveWindow") throw new Error("SPEND_FATE_CHEAT_WEAPON not allowed in this phase");
      if (nextState.player.fate < 2) throw new Error("Not enough Fate");
      addFate(nextState, -2, events);
      nextState.player.buffs.cheatWeaponNextEnemyFight = true;
      return { nextState, events };
    }

    case "USE_SPELL_CLEANSE": {
      if (nextState.phase !== "PreResolveWindow") throw new Error("USE_SPELL_CLEANSE not allowed in this phase");
      if (!nextState.player.spell) throw new Error("No spell prepared");
      const cardId = nextState.room.slots[action.slotIndex];
      if (!cardId) throw new Error("Slot is empty");
      const discarded = nextState.player.spell.cardId;
      nextState.player.spell = null;
      exileToFloorDiscard(nextState, discarded, events);
      nextState.room.pendingCleanses[action.slotIndex] = true;
      return { nextState, events };
    }

    case "USE_SPELL_REROLL": {
      if (nextState.phase !== "PreResolveWindow") throw new Error("USE_SPELL_REROLL not allowed in this phase");
      if (!nextState.player.spell) throw new Error("No spell prepared");
      const cardId = nextState.room.slots[action.slotIndex];
      if (!cardId) throw new Error("Slot is empty");
      const discarded = nextState.player.spell.cardId;
      nextState.player.spell = null;
      exileToFloorDiscard(nextState, discarded, events);
      bottomToMinorDeck(nextState, cardId, events);
      nextState.room.pendingCleanses[action.slotIndex] = false;
      nextState.room.slots[action.slotIndex] = drawFromMinorDeck(nextState);
      return { nextState, events };
    }

    case "COMMIT_RESOLVE": {
      if (nextState.phase !== "PreResolveWindow") throw new Error("COMMIT_RESOLVE not allowed in this phase");
      if (!computeAllowedCommitSlots(nextState).includes(action.slotIndex)) throw new Error("Slot not legal to resolve");
      const cardId = nextState.room.slots[action.slotIndex];
      if (!cardId) throw new Error("Slot is empty");
      nextState.phase = "ResolveCommit";
      nextState.debug = { ...(nextState.debug ?? {}), pendingResolution: { slotIndex: action.slotIndex, cardId } };
      autoAdvance(nextState, events);
      return { nextState, events };
    }

    case "ACE_CHOICE":
    case "ENEMY_FIGHT_CHOICE":
    case "SWORDS_AMBUSH_BLOCK_CHOICE":
    case "CUPS_8_10_CHOICE": {
      if (nextState.phase !== "ResolveExecute") throw new Error(`${action.type} not allowed in this phase`);
      const pending = nextState.debug?.pendingResolution;
      if (!pending) throw new Error("No pending resolution");

      const slotIndex = pending.slotIndex;
      const resolvingCardId = nextState.room.slots[slotIndex];
      if (!resolvingCardId || resolvingCardId !== pending.cardId) throw new Error("Pending resolution card mismatch");

      const card = getCard(nextState, resolvingCardId);
      const effective = computeEffectiveOrientation(nextState, slotIndex, card);

      const finalize = (discardToFloor: boolean) => {
        completeResolvedCard(nextState, events, slotIndex, resolvingCardId, effective, discardToFloor);
        autoAdvance(nextState, events);
      };

      // Resolve by kind
      if (card.rank.kind === "ace") {
        if (action.type !== "ACE_CHOICE") throw new Error("Expected ACE_CHOICE");
        if (card.suit === "pentacles") {
          if (action.optionId === "pay5_heal5") {
            if (nextState.player.gold < 5) throw new Error("Not enough gold");
            addGold(nextState, -5, events);
            applyHeal(nextState, 5, events);
          } else if (action.optionId === "gain5_take3") {
            addGold(nextState, 5, events);
            applyDamage(nextState, 3, events);
          } else {
            throw new Error("Unknown pentacles ace optionId");
          }
          finalize(true);
          return { nextState, events };
        }
        if (card.suit === "cups") {
          if (action.optionId === "heal_to_full") {
            applyHeal(nextState, nextState.player.maxHp, events);
          } else if (action.optionId === "cleanse_free") {
            const t = action.slotIndex;
            if (t === undefined) throw new Error("Missing slotIndex for cleanse_free");
            const targetId = nextState.room.slots[t];
            if (!targetId) throw new Error("Target slot empty");
            const targetCard = getCard(nextState, targetId);
            const eff = computeEffectiveOrientation(nextState, t, targetCard);
            if (eff !== "reversed") throw new Error("Can only cleanse effective-reversed cards");
            nextState.room.pendingCleanses[t] = true;
          } else {
            throw new Error("Unknown cups ace optionId");
          }
          finalize(true);
          return { nextState, events };
        }
        if (card.suit === "wands") {
          const t = action.slotIndex;
          if (t === undefined) throw new Error("Missing slotIndex for wands ace option");
          if (nextState.room.slots[t] === null) throw new Error("Target slot empty");
          if (action.optionId === "exile_replace_free") {
            const targetId = nextState.room.slots[t]!;
            exileToFloorDiscard(nextState, targetId, events);
            nextState.room.pendingCleanses[t] = false;
            nextState.room.slots[t] = drawFromMinorDeck(nextState);
          } else if (action.optionId === "reroll_free") {
            const targetId = nextState.room.slots[t]!;
            bottomToMinorDeck(nextState, targetId, events);
            nextState.room.pendingCleanses[t] = false;
            nextState.room.slots[t] = drawFromMinorDeck(nextState);
          } else {
            throw new Error("Unknown wands ace optionId");
          }
          finalize(true);
          return { nextState, events };
        }
        if (card.suit === "swords") {
          if (action.optionId === "cheat_weapon_free") {
            nextState.player.buffs.cheatWeaponThisRoom = true;
          } else if (action.optionId === "reroll_free") {
            const t = action.slotIndex;
            if (t === undefined) throw new Error("Missing slotIndex for reroll_free");
            if (nextState.room.slots[t] === null) throw new Error("Target slot empty");
            const targetId = nextState.room.slots[t]!;
            bottomToMinorDeck(nextState, targetId, events);
            nextState.room.pendingCleanses[t] = false;
            nextState.room.slots[t] = drawFromMinorDeck(nextState);
          } else {
            throw new Error("Unknown swords ace optionId");
          }
          finalize(true);
          return { nextState, events };
        }
      }

      if (isCourt(card)) {
        if (action.type !== "ENEMY_FIGHT_CHOICE") throw new Error("Expected ENEMY_FIGHT_CHOICE");
        const enemyVal = computeEnemyValue(card, effective);
        if (action.enemyMode === "weapon") {
          if (!nextState.player.weapon) throw new Error("No weapon equipped");
          if (!canUseWeaponAgainstEnemy(nextState, enemyVal)) throw new Error("Weapon restricted");
          const dmg = Math.max(0, enemyVal - nextState.player.weapon.value);
          applyDamage(nextState, dmg, events);
          nextState.player.weapon.lastHelpedDefeatValue = enemyVal;
          nextState.player.weapon.tuckedEnemyIds.push(resolvingCardId);
          nextState.player.buffs.cheatWeaponNextEnemyFight = false;
          nextState.player.buffs.cheatWeaponThisRoom = false;
        } else {
          applyDamage(nextState, enemyVal, events);
        }
        finalize(true);
        return { nextState, events };
      }

      if (card.rank.kind === "number") {
        const v = computeMinorNumericValue(card.rank);
        if (card.suit === "pentacles") {
          if (effective === "upright") {
            addGold(nextState, v, events);
          } else {
            const lose = Math.min(nextState.player.gold, v);
            addGold(nextState, -lose, events);
            const remainder = v - lose;
            if (remainder > 0) applyDamage(nextState, remainder, events);
          }
          finalize(true);
          return { nextState, events };
        }

        if (card.suit === "cups") {
          if (effective === "upright") {
            if (v >= 8) {
              if (action.type !== "CUPS_8_10_CHOICE") throw new Error("Expected CUPS_8_10_CHOICE");
              if (action.cupsChoice === "equipArmor") {
                nextState.player.armor = { cardId: resolvingCardId, value: v };
                events.push({ type: "EQUIP_ARMOR", cardId: resolvingCardId, value: v });
                finalize(false);
                return { nextState, events };
              } else {
                applyHeal(nextState, v, events);
              }
            } else {
              applyHeal(nextState, v, events);
            }
          } else {
            // Reversed cups ignores armor by rule; apply damage directly.
            const prevArmor = nextState.player.armor;
            nextState.player.armor = null;
            applyDamage(nextState, v, events);
            nextState.player.armor = prevArmor;
          }
          finalize(true);
          return { nextState, events };
        }

        if (card.suit === "wands") {
          if (effective === "upright") {
            nextState.player.spell = { cardId: resolvingCardId, value: v };
            events.push({ type: "EQUIP_SPELL", cardId: resolvingCardId, value: v });
            finalize(false);
            return { nextState, events };
          } else {
            if (nextState.player.spell) {
              const discarded = nextState.player.spell.cardId;
              nextState.player.spell = null;
              exileToFloorDiscard(nextState, discarded, events);
              events.push({ type: "DISCARD_EQUIPMENT", kind: "spell", cardId: discarded });
            } else {
              applyDamage(nextState, 2, events);
            }
          }
          finalize(true);
          return { nextState, events };
        }

        if (card.suit === "swords") {
          if (effective === "upright") {
            const prev = nextState.player.weapon;
            if (prev) {
              exileToFloorDiscard(nextState, prev.cardId, events);
              events.push({ type: "DISCARD_EQUIPMENT", kind: "weapon", cardId: prev.cardId });
            }
            nextState.player.weapon = { cardId: resolvingCardId, value: v, lastHelpedDefeatValue: null, tuckedEnemyIds: [] };
            events.push({ type: "EQUIP_WEAPON", cardId: resolvingCardId, value: v });
            finalize(false);
            return { nextState, events };
          } else {
            if (nextState.player.weapon) {
              if (action.type !== "SWORDS_AMBUSH_BLOCK_CHOICE") throw new Error("Expected SWORDS_AMBUSH_BLOCK_CHOICE");
              const dmg = action.block ? Math.max(0, v - nextState.player.weapon.value) : v;
              applyDamage(nextState, dmg, events);
            } else {
              applyDamage(nextState, v, events);
            }
          }
          finalize(true);
          return { nextState, events };
        }
      }

      throw new Error("Unhandled resolve branch");
    }

    default:
      throw new Error("Unknown action");
  }
}
