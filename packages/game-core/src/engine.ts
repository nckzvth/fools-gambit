import { Xorshift32 } from "./rng/xorshift32.js";
import type { EffectNode } from "./content.js";
import { getLoadedContent } from "./content.js";
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
import { beginMajorEffectPrompt, clearMajorPrompt, getMajorPrompt, getMajorPromptLegalActions, getFloorMajorShadow } from "./majors.js";

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

function withRng<T>(state: RunState, fn: (rng: Xorshift32) => T): T {
  const rng = new Xorshift32(state.rng.state);
  const out = fn(rng);
  state.rng.state = rng.state;
  return out;
}

function computeBossRoomsRequired(floorNumber: number): number {
  if (floorNumber <= 7) return 2;
  if (floorNumber <= 14) return 3;
  return 4;
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
    carryChoiceIndex: null,
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
    if (state.player.hp <= 0) state.phase = "RunDefeat";
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
  const id = (state.floor.bossMode ? state.floor.bossDeck?.shift() : state.decks.minorDeck.shift()) ?? null;
  if (!id) throw new Error("Minor deck is empty");
  return id;
}

function bottomToActiveDeck(state: RunState, cardId: CardId, events: GameEvent[]) {
  if (state.floor.bossMode) {
    if (!state.floor.bossDeck) throw new Error("bossDeck missing in bossMode");
    state.floor.bossDeck.push(cardId);
  } else {
    state.decks.minorDeck.push(cardId);
  }
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

  const shadow = getFloorMajorShadow(state, "ROOM_REVEALED");
  if (shadow) applyMajorEffect(state, state.floor.activeMajorId, shadow, events);
}

function startFloor(state: RunState) {
  // Rebuild minorDeck from all minors excluding equipped items, then shuffle deterministically.
  const all = Object.keys(state.decks.cards.minors);
  const excluded = new Set<CardId>();
  if (state.player.weapon) excluded.add(state.player.weapon.cardId);
  if (state.player.armor) excluded.add(state.player.armor.cardId);
  if (state.player.spell) excluded.add(state.player.spell.cardId);

  const deck = all.filter((id) => !excluded.has(id));
  withRng(state, (rng) => fisherYatesShuffle(deck, rng));

  state.decks.minorDeck = deck;
  state.floor.floorDiscard = [];
  state.floor.bossMode = false;
  state.floor.bossDeck = null;
  state.floor.engagedRoomsCompleted = 0;
  state.floor.bossRoomsCompleted = 0;
  state.floor.bossRoomsRequired = computeBossRoomsRequired(state.floor.floorNumber);
  state.room = buildInitialRoom(null);

  state.rules.weaponRestrictionMode = "DEFAULT";
  state.rules.orderConstraint = { kind: "NONE", requiresChooseCarriedFirst: false, scopeMajorId: null };
  state.floor.params = { chariotDirection: null };

  state.debug ??= {};
  (state.debug as any).floorStartForFloorNumber = state.floor.floorNumber;
  (state.debug as any).floorStartAttunementChosen = false;
  (state.debug as any).floorStartAppliedFloorStartHook = false;
  (state.debug as any).floorStartAppliedOrderConstraintHook = false;
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

  if (state.phase === "RoomEnd") {
    if (state.floor.bossMode) state.floor.bossRoomsCompleted += 1;
    else state.floor.engagedRoomsCompleted += 1;
  }

  // AFTER_FIRST_RESOLUTION hook (e.g., Sun shadow).
  if (resolvedCount(state) === 1) {
    const shadow = getFloorMajorShadow(state, "AFTER_FIRST_RESOLUTION");
    if (shadow) applyMajorEffect(state, state.floor.activeMajorId, shadow, events);
  }
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

  const carryChoiceIndex = state.room.carryChoiceIndex;
  const allowed = carryChoiceIndex === null ? occupied : occupied.filter((i) => i !== carryChoiceIndex);
  const constraint = state.rules.orderConstraint.kind;
  const requiresChooseCarriedFirst = state.rules.orderConstraint.requiresChooseCarriedFirst;

  if (requiresChooseCarriedFirst && carryChoiceIndex === null) return [];
  if (constraint === "NONE") return allowed;

  const nonCarried = allowed;
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

function applyMajorEffect(state: RunState, majorId: MajorId, effect: EffectNode, events: GameEvent[]) {
  if (state.debug?.pendingPrompt) return;

  switch (effect.type) {
    case "NOOP":
      return;

    case "SEQUENCE": {
      for (const child of effect.effects ?? []) {
        applyMajorEffect(state, majorId, child, events);
        if (state.debug?.pendingPrompt) return;
      }
      return;
    }

    case "CONDITIONAL": {
      const pred = effect.if;
      if (!pred || !effect.then || !effect.else) throw new Error("CONDITIONAL requires if/then/else");
      const ok =
        pred.kind === "ROOM_HAS_ENEMY"
          ? state.room.slots.some((id) => id && state.decks.cards.minors[id]!.rank.kind === "court")
          : pred.kind === "ROOM_HAS_ANY_EFFECTIVE_REVERSED"
            ? state.room.slots.some((id, idx) => {
                if (!id) return false;
                const card = state.decks.cards.minors[id]!;
                return computeEffectiveOrientation(state, idx, card) === "reversed";
              })
            : pred.kind === "PLAYER_GOLD_AT_LEAST"
              ? state.player.gold >= (pred.value ?? 0)
              : false;
      applyMajorEffect(state, majorId, ok ? effect.then : effect.else, events);
      return;
    }

    case "CHOICE":
    case "BARGAIN":
    case "REORDER_TOP_N":
    case "REORDER_ROOM_ARBITRARY": {
      beginMajorEffectPrompt(state, majorId, effect);
      return;
    }

    case "PEEK_TOP_N": {
      const deck = state.floor.bossMode ? state.floor.bossDeck : state.decks.minorDeck;
      const n = effect.n ?? 3;
      const top = (deck ?? []).slice(0, n);
      events.push({ type: "PEEK_TOP_N", n, cardIds: top });
      if (effect.canReorder) {
        state.debug ??= {};
        state.debug.pendingPrompt = { kind: "MAJOR_REORDER_TOP3", majorId };
        (state.debug as any).pendingMajorPrompt = { kind: "REORDER_TOP3", majorId };
      }
      return;
    }

    case "REORDER_ROOM_BY_VALUE": {
      const prevCarriedId = state.room.carriedIndex === null ? null : state.room.slots[state.room.carriedIndex];
      const prevCarryChoiceId = state.room.carryChoiceIndex === null ? null : state.room.slots[state.room.carryChoiceIndex];
      const order = [0, 1, 2, 3]
        .map((idx) => {
          const id = state.room.slots[idx];
          if (!id) return { idx, value: -1 };
          const card = state.decks.cards.minors[id]!;
          const eff = computeEffectiveOrientation(state, idx, card);
          const orderingValue =
            card.rank.kind === "ace" ? 1 : card.rank.kind === "number" ? computeMinorNumericValue(card.rank) : computeEnemyValue(card, eff);
          return { idx, value: orderingValue };
        })
        .sort((a, b) => a.value - b.value || a.idx - b.idx)
        .map((x) => x.idx);
      state.room.slots = order.map((i) => state.room.slots[i]) as any;
      state.room.pendingCleanses = order.map((i) => state.room.pendingCleanses[i]) as any;
      state.room.resolvedMask = order.map((i) => state.room.resolvedMask[i]) as any;
      if (prevCarriedId) state.room.carriedIndex = state.room.slots.findIndex((id) => id === prevCarriedId);
      if (prevCarryChoiceId) state.room.carryChoiceIndex = state.room.slots.findIndex((id) => id === prevCarryChoiceId);
      return;
    }

    case "DISABLE_FATE_ACTION": {
      if (effect.scope !== "THIS_ROOM" || !effect.fateAction) return;
      if (!state.room.disabledFateActionsThisRoom.includes(effect.fateAction)) state.room.disabledFateActionsThisRoom.push(effect.fateAction);
      return;
    }

    case "SET_WEAPON_RESTRICTION_MODE": {
      if (effect.scope !== "THIS_FLOOR" || !effect.weaponRestrictionMode) return;
      state.rules.weaponRestrictionMode = effect.weaponRestrictionMode;
      return;
    }

    case "SET_ORDER_CONSTRAINT": {
      if (effect.scope !== "THIS_FLOOR" || !effect.orderConstraint) return;
      const kind =
        effect.orderConstraint === "ASC_VALUE"
          ? "ASC_ORDERING_VALUE"
          : effect.orderConstraint === "LEFT_TO_RIGHT"
            ? "LEFT_TO_RIGHT"
            : effect.orderConstraint === "RIGHT_TO_LEFT"
              ? "RIGHT_TO_LEFT"
              : effect.orderConstraint === "SUIT_ORDER"
                ? "SUIT_ORDER"
                : "NONE";
      state.rules.orderConstraint = {
        kind,
        requiresChooseCarriedFirst: Boolean(effect.requiresChooseCarriedFirst),
        scopeMajorId: state.floor.activeMajorId
      };
      return;
    }

    case "SET_FLOOR_PARAM": {
      if (effect.scope !== "THIS_FLOOR" || !effect.paramKey) return;
      if (effect.paramKey === "cheatWeapon") {
        state.player.buffs.cheatWeaponNextEnemyFight = true;
        return;
      }
      if (effect.paramKey === "chariotDirection") {
        if (effect.paramValue !== "LEFT_TO_RIGHT" && effect.paramValue !== "RIGHT_TO_LEFT") throw new Error("Invalid chariotDirection paramValue");
        state.floor.params.chariotDirection = effect.paramValue;
        return;
      }
      return;
    }

    case "FORCED_EXILE_FIRST_RESOLVE_ATTEMPT":
      return;

    case "REROLL_REVEALED":
    case "EXILE_REPLACE_REVEALED":
    case "CLEANSE_REVEALED": {
      const selector = effect.selector;
      if (!selector) throw new Error(`${effect.type} requires selector`);

      const occupied = [0, 1, 2, 3].filter((i) => state.room.slots[i] !== null);
      const effectiveReversed = occupied.filter((i) => {
        const id = state.room.slots[i]!;
        const card = state.decks.cards.minors[id]!;
        return computeEffectiveOrientation(state, i, card) === "reversed";
      });
      const hasEnemy = occupied.some((i) => {
        const id = state.room.slots[i]!;
        return state.decks.cards.minors[id]!.rank.kind === "court";
      });

      let candidates = occupied;
      if (effect.type === "CLEANSE_REVEALED") candidates = effectiveReversed;
      if (selector.kind === "IF_ENEMY_PRESENT_PLAYER_CHOICE") candidates = hasEnemy ? candidates : [];
      if (selector.kind === "IF_ANY_REVERSED_PLAYER_CHOICE") candidates = effectiveReversed;
      if (candidates.length === 0) return;

      const choosePlayer = () => {
        if (candidates.length === 1) {
          applyMajorEffectToSlot(state, effect, candidates[0]!, events);
          return;
        }
        state.debug ??= {};
        state.debug.pendingPrompt = { kind: "MAJOR_CHOICE", majorId, promptKey: "major.selectTarget", optionIds: candidates.map(String) };
        (state.debug as any).pendingMajorPrompt = { kind: "SELECT_TARGET", majorId, effect, candidates };
      };

      if (selector.kind === "PLAYER_CHOICE" || selector.kind === "IF_ENEMY_PRESENT_PLAYER_CHOICE" || selector.kind === "IF_ANY_REVERSED_PLAYER_CHOICE") {
        choosePlayer();
        return;
      }

      if (selector.kind === "LEFTMOST") {
        applyMajorEffectToSlot(state, effect, Math.min(...candidates), events);
        return;
      }

      if (selector.kind === "RANDOM") {
        const slotIndex = candidates[withRng(state, (rng) => rng.nextUint32() % candidates.length)]!;
        applyMajorEffectToSlot(state, effect, slotIndex, events);
        return;
      }

      // HIGHEST_VALUE
      const scored = candidates
        .map((i) => {
          const id = state.room.slots[i]!;
          const card = state.decks.cards.minors[id]!;
          const v =
            card.rank.kind === "ace"
              ? 1
              : card.rank.kind === "number"
                ? computeMinorNumericValue(card.rank)
                : computeEnemyValue(card, computeEffectiveOrientation(state, i, card));
          return { i, v };
        })
        .sort((a, b) => b.v - a.v || a.i - b.i);
      const max = scored[0]!.v;
      const tied = scored.filter((x) => x.v === max).map((x) => x.i);
      candidates = tied;
      choosePlayer();
      return;
    }
  }
}

function applyMajorEffectToSlot(state: RunState, effect: EffectNode, slotIndex: number, events: GameEvent[]) {
  const cardId = state.room.slots[slotIndex];
  if (!cardId) return;

  if (effect.type === "CLEANSE_REVEALED") {
    const card = state.decks.cards.minors[cardId]!;
    if (computeEffectiveOrientation(state, slotIndex, card) !== "reversed") return;
    state.room.pendingCleanses[slotIndex] = true;
    return;
  }

  if (effect.type === "REROLL_REVEALED") {
    bottomToActiveDeck(state, cardId, events);
    state.room.pendingCleanses[slotIndex] = false;
    state.room.slots[slotIndex] = drawFromMinorDeck(state);
    return;
  }

  if (effect.type === "EXILE_REPLACE_REVEALED") {
    exileToFloorDiscard(state, cardId, events);
    state.room.pendingCleanses[slotIndex] = false;
    state.room.slots[slotIndex] = drawFromMinorDeck(state);
    return;
  }
}

function autoAdvance(state: RunState, events: GameEvent[]) {
  while (true) {
    if (state.phase === "RunInit") {
      state.phase = "FloorStart";
      continue;
    }
    if (state.phase === "FloorStart") {
      state.debug ??= {};
      const dbg: any = state.debug;
      if (dbg.floorStartForFloorNumber !== state.floor.floorNumber) startFloor(state);
      if (state.debug.pendingPrompt) break;
      if (!dbg.floorStartAttunementChosen) break;
      if (!dbg.floorStartAppliedFloorStartHook) {
        dbg.floorStartAppliedFloorStartHook = true;
        const shadow = getFloorMajorShadow(state, "FLOOR_START");
        if (shadow) applyMajorEffect(state, state.floor.activeMajorId, shadow, events);
        if (state.debug.pendingPrompt) break;
      }
      if (!dbg.floorStartAppliedOrderConstraintHook) {
        dbg.floorStartAppliedOrderConstraintHook = true;
        const shadow = getFloorMajorShadow(state, "ORDER_CONSTRAINT");
        if (shadow) applyMajorEffect(state, state.floor.activeMajorId, shadow, events);
        if (state.debug.pendingPrompt) break;
      }
      state.phase = "RoomReveal";
      continue;
    }
    if (state.phase === "RoomReveal") {
      fillRoomToFour(state, events);
      break;
    }
    if (state.phase === "EngageSetup") {
      const requiresChooseCarriedFirst = state.rules.orderConstraint.requiresChooseCarriedFirst;
      if (requiresChooseCarriedFirst && state.room.carryChoiceIndex === null) break;
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

      if (state.floor.bossMode) {
        if (state.floor.bossRoomsCompleted >= state.floor.bossRoomsRequired) {
          // Floor victory: claim major and advance.
          const defeated = state.floor.activeMajorId;
          if (!state.majors.claimed.includes(defeated)) state.majors.claimed.push(defeated);
          if (!state.majors.spentThisFloor.includes(defeated)) state.majors.spentThisFloor.push(defeated);

          if (state.majors.claimed.length >= state.runLengthTarget) {
            state.phase = "RunVictory";
            break;
          }

          state.floor.floorNumber += 1;
          const nextMajor = state.decks.majorDeck.shift();
          if (!nextMajor) throw new Error("Major deck empty");
          state.floor.activeMajorId = nextMajor;
          state.majors.spentThisFloor = [];
          state.phase = "FloorStart";
          continue;
        }
      } else {
        if (state.floor.engagedRoomsCompleted >= 6) {
          // Start boss immediately with the carried card.
          state.floor.bossMode = true;
          state.floor.bossDeck = [...state.floor.floorDiscard];
          withRng(state, (rng) => fisherYatesShuffle(state.floor.bossDeck!, rng));
          state.floor.bossRoomsCompleted = 0;
          state.floor.bossRoomsRequired = computeBossRoomsRequired(state.floor.floorNumber);
        }
      }

      state.room = buildInitialRoom({ slotIndex: remainingIndex, cardId: carriedCardId });
      state.phase = "RoomReveal";
      continue;
    }
    break;
  }
}

export function createRun(config: EngineConfig): RunState {
  // Phase D: majors are driven by content and required for correct gameplay.
  getLoadedContent();

  const rng = new Xorshift32(config.seed);
  const { cards, deck } = buildMinorCards(rng);
  const majorDeck = [...ALL_MAJORS];
  fisherYatesShuffle(majorDeck, rng);
  const activeMajorId = majorDeck.shift() ?? "magician";

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
      activeMajorId,
      engagedRoomsCompleted: 0,
      floorDiscard: [],
      bossMode: false,
      bossRoomsRequired: computeBossRoomsRequired(1),
      bossRoomsCompleted: 0,
      bossDeck: null,
      params: { chariotDirection: null }
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

  if (state.debug?.pendingPrompt?.kind?.startsWith("MAJOR_")) {
    return getMajorPromptLegalActions(state);
  }

  if (state.phase === "FloorStart") {
    const claimed = state.majors.claimed;
    const uniqueClaimed = Array.from(new Set(claimed));
    const out: LegalAction[] = [];
    // Enumerate all subsets up to 3, deterministic order.
    out.push({ type: "SELECT_ATTUNEMENT", majorIds: [] });
    for (let i = 0; i < uniqueClaimed.length; i += 1) out.push({ type: "SELECT_ATTUNEMENT", majorIds: [uniqueClaimed[i]!] });
    for (let i = 0; i < uniqueClaimed.length; i += 1) {
      for (let j = i + 1; j < uniqueClaimed.length; j += 1) {
        out.push({ type: "SELECT_ATTUNEMENT", majorIds: [uniqueClaimed[i]!, uniqueClaimed[j]!] });
      }
    }
    for (let i = 0; i < uniqueClaimed.length; i += 1) {
      for (let j = i + 1; j < uniqueClaimed.length; j += 1) {
        for (let k = j + 1; k < uniqueClaimed.length; k += 1) {
          out.push({ type: "SELECT_ATTUNEMENT", majorIds: [uniqueClaimed[i]!, uniqueClaimed[j]!, uniqueClaimed[k]!] });
        }
      }
    }
    return out;
  }

  if (state.phase === "RoomChoice") {
    const out: LegalAction[] = [{ type: "CHOOSE_ENGAGE" }];
    if (!state.lastRoomWasFlee) out.push({ type: "CHOOSE_FLEE" });
    return out;
  }

  if (state.phase === "EngageSetup") {
    if (state.rules.orderConstraint.requiresChooseCarriedFirst && state.room.carryChoiceIndex === null) {
      return [0, 1, 2, 3]
        .filter((i) => state.room.slots[i] !== null)
        .map((slotIndex) => ({ type: "SELECT_CARRIED_CARD", slotIndex }));
    }
    return [];
  }

  if (state.phase === "PreResolveWindow") {
    const actions: LegalAction[] = [];
    const occupiedSlots = [0, 1, 2, 3].filter((i) => state.room.slots[i] !== null && !state.room.resolvedMask[i]);

    // Attuned Major gifts (once per floor, before committing resolve).
    for (const majorId of state.majors.attuned) {
      if (!state.majors.spentThisFloor.includes(majorId)) actions.push({ type: "USE_MAJOR_GIFT", majorId });
    }

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

  if (nextState.debug?.pendingPrompt?.kind?.startsWith("MAJOR_")) {
    const prompt = getMajorPrompt(nextState);
    if (!prompt) throw new Error("Major prompt missing payload");

    if (action.type === "USE_MAJOR_GIFT") {
      if (prompt.kind === "CHOICE") {
        if (action.majorId !== prompt.majorId) throw new Error("Prompt majorId mismatch");
        if (!action.optionId) throw new Error("Missing optionId");
        const idx = prompt.optionIds.indexOf(action.optionId);
        if (idx < 0) throw new Error("Unknown optionId");
        clearMajorPrompt(nextState);
        applyMajorEffect(nextState, prompt.majorId, prompt.optionEffects[idx]!, events);
        autoAdvance(nextState, events);
        return { nextState, events };
      }
      if (prompt.kind === "SELECT_TARGET") {
        if (action.majorId !== prompt.majorId) throw new Error("Prompt majorId mismatch");
        if (action.slotIndex === undefined) throw new Error("Missing slotIndex");
        if (!prompt.candidates.includes(action.slotIndex)) throw new Error("Slot not a candidate");
        clearMajorPrompt(nextState);
        applyMajorEffectToSlot(nextState, prompt.effect, action.slotIndex, events);
        autoAdvance(nextState, events);
        return { nextState, events };
      }
      throw new Error("USE_MAJOR_GIFT not valid for this major prompt");
    }

    if (action.type === "BARGAIN_CHOICE") {
      if (prompt.kind !== "BARGAIN") throw new Error("Expected BARGAIN prompt");
      const ix = prompt.options.findIndex((k) => k === action.bargainChoice);
      if (ix < 0) throw new Error("Bargain option not available");
      const opt = prompt.bargainOptions[ix]!;
      if (action.bargainChoice === "pay") {
        const payGold = opt.payGold ?? 0;
        if (nextState.player.gold < payGold) throw new Error("Not enough gold");
        if (payGold) addGold(nextState, -payGold, events);
      } else {
        const dmg = opt.takeDamage ?? 0;
        if (dmg) applyDamage(nextState, dmg, events);
      }
      if (opt.gainGold) addGold(nextState, opt.gainGold, events);
      if (opt.heal) applyHeal(nextState, opt.heal, events);
      clearMajorPrompt(nextState);
      autoAdvance(nextState, events);
      return { nextState, events };
    }

    if (action.type === "REORDER_TOP3") {
      if (prompt.kind !== "REORDER_TOP3") throw new Error("Expected REORDER_TOP3 prompt");
      const ord = action.order;
      if (ord.length !== 3) throw new Error("order must be length 3");
      if (new Set(ord).size !== 3) throw new Error("order must be a permutation");
      if (!ord.every((x) => x === 0 || x === 1 || x === 2)) throw new Error("order indices out of range");
      const deck = nextState.floor.bossMode ? nextState.floor.bossDeck : nextState.decks.minorDeck;
      if (!deck) throw new Error("Active deck missing");
      const top3 = deck.slice(0, 3);
      if (top3.length !== 3) throw new Error("Deck has fewer than 3 cards");
      const nextTop3 = ord.map((i) => top3[i]!) as CardId[];
      deck.splice(0, 3, ...nextTop3);
      clearMajorPrompt(nextState);
      autoAdvance(nextState, events);
      return { nextState, events };
    }

    if (action.type === "REORDER_ROOM4") {
      if (prompt.kind !== "REORDER_ROOM4") throw new Error("Expected REORDER_ROOM4 prompt");
      const ord = action.order;
      if (ord.length !== 4) throw new Error("order must be length 4");
      if (new Set(ord).size !== 4) throw new Error("order must be a permutation");
      if (!ord.every((x) => x === 0 || x === 1 || x === 2 || x === 3)) throw new Error("order indices out of range");
      const oldSlots = nextState.room.slots;
      const oldPending = nextState.room.pendingCleanses;
      const oldResolved = nextState.room.resolvedMask;
      const prevCarriedId = nextState.room.carriedIndex === null ? null : oldSlots[nextState.room.carriedIndex];
      const prevCarryChoiceId = nextState.room.carryChoiceIndex === null ? null : oldSlots[nextState.room.carryChoiceIndex];
      nextState.room.slots = ord.map((i) => oldSlots[i]!) as any;
      nextState.room.pendingCleanses = ord.map((i) => oldPending[i]!) as any;
      nextState.room.resolvedMask = ord.map((i) => oldResolved[i]!) as any;
      if (prevCarriedId) nextState.room.carriedIndex = nextState.room.slots.findIndex((id) => id === prevCarriedId);
      if (prevCarryChoiceId) nextState.room.carryChoiceIndex = nextState.room.slots.findIndex((id) => id === prevCarryChoiceId);
      clearMajorPrompt(nextState);
      autoAdvance(nextState, events);
      return { nextState, events };
    }

    throw new Error("Action not allowed while major prompt is pending");
  }

  switch (action.type) {
    case "SELECT_ATTUNEMENT": {
      if (nextState.phase !== "FloorStart") throw new Error("SELECT_ATTUNEMENT not allowed in this phase");
      const ids = action.majorIds;
      if (ids.length > 3) throw new Error("Can only attune up to 3 majors");
      if (new Set(ids).size !== ids.length) throw new Error("Duplicate majorIds");
      for (const id of ids) {
        if (!nextState.majors.claimed.includes(id)) throw new Error("Can only attune claimed majors");
      }
      nextState.majors.attuned = [...ids];
      nextState.majors.spentThisFloor = [];
      nextState.debug ??= {};
      (nextState.debug as any).floorStartAttunementChosen = true;
      autoAdvance(nextState, events);
      return { nextState, events };
    }

    case "CHOOSE_FLEE": {
      if (nextState.phase !== "RoomChoice") throw new Error("CHOOSE_FLEE not allowed in this phase");
      if (nextState.lastRoomWasFlee) throw new Error("Cannot flee two rooms in a row");

      for (let i = 0; i < 4; i += 1) {
        const id = nextState.room.slots[i];
        if (!id) continue;
        bottomToActiveDeck(nextState, id, events);
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
      nextState.room.carryChoiceIndex = action.slotIndex;
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

    case "USE_MAJOR_GIFT": {
      if (nextState.phase !== "PreResolveWindow") throw new Error("USE_MAJOR_GIFT not allowed in this phase");
      const majorId = action.majorId;
      if (!nextState.majors.attuned.includes(majorId)) throw new Error("Major is not attuned");
      if (nextState.majors.spentThisFloor.includes(majorId)) throw new Error("Major already spent this floor");
      const major = getLoadedContent().majorById[majorId];
      if (!major) throw new Error("Unknown majorId");
      nextState.majors.spentThisFloor.push(majorId);
      applyMajorEffect(nextState, majorId, major.gift.effect, events);
      autoAdvance(nextState, events);
      return { nextState, events };
    }

    case "SPEND_FATE_REROLL": {
      if (nextState.phase !== "PreResolveWindow") throw new Error("SPEND_FATE_REROLL not allowed in this phase");
      if (nextState.room.disabledFateActionsThisRoom.includes("REROLL")) throw new Error("Fate reroll disabled this room");
      if (nextState.player.fate < 1) throw new Error("Not enough Fate");
      const cardId = nextState.room.slots[action.slotIndex];
      if (!cardId) throw new Error("Slot is empty");
      addFate(nextState, -1, events);
      bottomToActiveDeck(nextState, cardId, events);
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
      bottomToActiveDeck(nextState, cardId, events);
      nextState.room.pendingCleanses[action.slotIndex] = false;
      nextState.room.slots[action.slotIndex] = drawFromMinorDeck(nextState);
      return { nextState, events };
    }

    case "COMMIT_RESOLVE": {
      if (nextState.phase !== "PreResolveWindow") throw new Error("COMMIT_RESOLVE not allowed in this phase");
      if (!computeAllowedCommitSlots(nextState).includes(action.slotIndex)) throw new Error("Slot not legal to resolve");
      const cardId = nextState.room.slots[action.slotIndex];
      if (!cardId) throw new Error("Slot is empty");

      // BEFORE_FIRST_RESOLVE_ATTEMPT hook (e.g., Hanged Man): first attempt is exiled + replaced.
      if (!nextState.room.hangedManTriggeredThisRoom && resolvedCount(nextState) === 0) {
        const shadow = getFloorMajorShadow(nextState, "BEFORE_FIRST_RESOLVE_ATTEMPT");
        if (shadow?.type === "FORCED_EXILE_FIRST_RESOLVE_ATTEMPT") {
          nextState.room.hangedManTriggeredThisRoom = true;
          exileToFloorDiscard(nextState, cardId, events);
          nextState.room.pendingCleanses[action.slotIndex] = false;
          nextState.room.slots[action.slotIndex] = drawFromMinorDeck(nextState);
          autoAdvance(nextState, events);
          return { nextState, events };
        }
      }

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
            bottomToActiveDeck(nextState, targetId, events);
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
            bottomToActiveDeck(nextState, targetId, events);
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
