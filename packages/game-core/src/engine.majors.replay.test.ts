import { readFileSync } from "node:fs";

import { beforeAll, describe, expect, it } from "vitest";

import { loadContent } from "./content.js";
import { applyAction, createRun, getLegalActions } from "./engine.js";
import type { EffectNode, HookId } from "./content.js";
import type { LegalAction, MajorId, RunState } from "./types.js";
import { computeEffectiveOrientation, computeEnemyValue, computeMinorNumericValue, isCourt } from "./rules.js";

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

function stripDebug(state: RunState): RunState {
  const s = structuredClone(state);
  delete (s as any).debug;
  return s;
}

function effectTypes(effect: EffectNode, out = new Set<EffectNode["type"]>()): Set<EffectNode["type"]> {
  out.add(effect.type);
  if (effect.type === "SEQUENCE") for (const child of effect.effects ?? []) effectTypes(child, out);
  if (effect.type === "CHOICE") for (const opt of effect.options ?? []) effectTypes(opt.effect, out);
  if (effect.type === "CONDITIONAL") {
    if (effect.then) effectTypes(effect.then, out);
    if (effect.else) effectTypes(effect.else, out);
  }
  return out;
}

function orderingValue(state: RunState, slotIndex: number): number {
  const cardId = state.room.slots[slotIndex];
  if (!cardId) return -1;
  const card = state.decks.cards.minors[cardId]!;
  const eff = computeEffectiveOrientation(state, slotIndex, card);
  if (card.rank.kind === "ace") return 1;
  if (card.rank.kind === "number") return computeMinorNumericValue(card.rank);
  if (isCourt(card)) return computeEnemyValue(card, eff);
  return -1;
}

function isSortedRoomByValueAsc(state: RunState): boolean {
  const occupied = [0, 1, 2, 3].filter((i) => state.room.slots[i] !== null);
  const vals = occupied.map((i) => ({ i, v: orderingValue(state, i) }));
  const sorted = [...vals].sort((a, b) => a.v - b.v || a.i - b.i);
  return JSON.stringify(vals) === JSON.stringify(sorted);
}

type Coverage = {
  sawPeekEvent: boolean;
  sawDisabledFate: boolean;
  sawOrderConstraint: boolean;
  sawWeaponRestrictionStrict: boolean;
  sawFloorParam: boolean;
  sawHangedMan: boolean;
  sawBargainDelta: boolean;
  sawBottomOrExile: boolean;
  sawWorldSortedAtReveal: boolean;
};

function chooseAction(state: RunState, majorId: MajorId, giftUsed: boolean): LegalAction {
  const legal = getLegalActions(state);
  if (legal.length === 0) throw new Error(`No legal actions at phase=${state.phase}`);

  if (state.phase === "FloorStart") {
    const preferred = legal.find((a) => a.type === "SELECT_ATTUNEMENT" && a.majorIds.length === 1 && a.majorIds[0] === majorId);
    return preferred ?? legal[0]!;
  }

  if (!giftUsed) {
    const gift = legal.find((a) => a.type === "USE_MAJOR_GIFT" && a.majorId === majorId);
    if (gift) return gift;
  }

  const ace = legal.find((a) => a.type === "ACE_CHOICE");
  if (ace && ace.type === "ACE_CHOICE") {
    if (ace.optionId === "pay5_heal5" && state.player.gold < 5) {
      const fallback = legal.find((a) => a.type === "ACE_CHOICE" && a.optionId === "gain5_take3");
      if (fallback) return fallback;
    }
    if (ace.optionId === "cleanse_free") {
      const healToFull = legal.find((a) => a.type === "ACE_CHOICE" && a.optionId === "heal_to_full");
      if (healToFull) return healToFull;
    }
    return ace;
  }

  const engage = legal.find((a) => a.type === "CHOOSE_ENGAGE");
  if (engage) return engage;

  const commit = legal.find((a) => a.type === "COMMIT_RESOLVE");
  if (commit) return commit;

  const weapon = legal.find((a) => a.type === "ENEMY_FIGHT_CHOICE" && a.enemyMode === "weapon");
  if (weapon) return weapon;

  return legal[0]!;
}

let majorsContent: { majors: Array<{ id: MajorId; shadow: { trigger: HookId; effect: EffectNode }; gift: { effect: EffectNode } }> } | null = null;

function runMajorReplay(majorId: MajorId, seed: number): { start: RunState; actions: LegalAction[]; end: RunState; coverage: Coverage } {
  if (!majorsContent) throw new Error("majorsContent not loaded");
  const major = majorsContent.majors.find((m) => m.id === majorId);
  if (!major) throw new Error("Major not found in content");
  const shadowTypes = effectTypes(major.shadow.effect);

  let s = createRun({ seed, runLengthTarget: 7 });
  s.floor.activeMajorId = majorId;
  s.majors.claimed = [majorId];
  s.player.hp = 999;
  s.player.maxHp = 999;
  s.player.gold = 0;
  s.player.fate = 10;

  const actions: LegalAction[] = [];
  const coverage: Coverage = {
    sawPeekEvent: false,
    sawDisabledFate: false,
    sawOrderConstraint: false,
    sawWeaponRestrictionStrict: false,
    sawFloorParam: false,
    sawHangedMan: false,
    sawBargainDelta: false,
    sawBottomOrExile: false,
    sawWorldSortedAtReveal: false
  };

  let reachedFirstRoomChoice = false;
  let giftUsed = false;
  let resolvedAtLeastOne = false;

  for (let step = 0; step < 300; step += 1) {
    if (s.room.disabledFateActionsThisRoom.length > 0) coverage.sawDisabledFate = true;
    if (s.rules.orderConstraint.kind !== "NONE") coverage.sawOrderConstraint = true;
    if (s.rules.weaponRestrictionMode === "STRICT") coverage.sawWeaponRestrictionStrict = true;
    if (s.floor.params.chariotDirection !== null) coverage.sawFloorParam = true;
    if (s.room.hangedManTriggeredThisRoom) coverage.sawHangedMan = true;
    if (s.majors.spentThisFloor.includes(majorId)) giftUsed = true;
    if (s.room.resolvedMask.some(Boolean)) resolvedAtLeastOne = true;

    if (!reachedFirstRoomChoice && s.phase === "RoomChoice") {
      reachedFirstRoomChoice = true;
      if (shadowTypes.has("REORDER_ROOM_BY_VALUE")) coverage.sawWorldSortedAtReveal = isSortedRoomByValueAsc(s);
    }

    if (giftUsed && resolvedAtLeastOne && reachedFirstRoomChoice && !s.debug?.pendingPrompt && s.phase === "PreResolveWindow") break;

    const a = chooseAction(s, majorId, giftUsed);
    actions.push(a);
    const res = applyAction(s, a);
    for (const e of res.events) {
      if (e.type === "PEEK_TOP_N") coverage.sawPeekEvent = true;
      if (e.type === "PLAYER_HP_CHANGED" || e.type === "PLAYER_GOLD_CHANGED") coverage.sawBargainDelta = true;
      if (e.type === "CARD_BOTTOMED" || e.type === "CARD_EXILED") coverage.sawBottomOrExile = true;
    }
    s = res.nextState;
  }

  if (!giftUsed) throw new Error(`Gift was not used for majorId=${majorId}`);
  if (!reachedFirstRoomChoice) throw new Error(`Did not reach first RoomChoice for majorId=${majorId}`);
  if (!resolvedAtLeastOne && major.shadow.trigger !== "ORDER_CONSTRAINT" && major.shadow.trigger !== "FLOOR_START") {
    throw new Error(`Did not resolve any card for majorId=${majorId}`);
  }

  // Minimal shadow coverage assertions based on the shadow's primitive types.
  if (shadowTypes.has("PEEK_TOP_N")) expect(coverage.sawPeekEvent).toBe(true);
  if (shadowTypes.has("DISABLE_FATE_ACTION")) expect(coverage.sawDisabledFate).toBe(true);
  if (shadowTypes.has("SET_ORDER_CONSTRAINT")) expect(coverage.sawOrderConstraint).toBe(true);
  if (shadowTypes.has("SET_WEAPON_RESTRICTION_MODE")) expect(coverage.sawWeaponRestrictionStrict).toBe(true);
  if (shadowTypes.has("SET_FLOOR_PARAM")) expect(coverage.sawFloorParam).toBe(true);
  if (shadowTypes.has("FORCED_EXILE_FIRST_RESOLVE_ATTEMPT")) expect(coverage.sawHangedMan).toBe(true);
  if (shadowTypes.has("BARGAIN")) expect(coverage.sawBargainDelta).toBe(true);
  if (shadowTypes.has("REROLL_REVEALED") || shadowTypes.has("EXILE_REPLACE_REVEALED")) expect(coverage.sawBottomOrExile).toBe(true);
  if (shadowTypes.has("REORDER_ROOM_BY_VALUE")) expect(coverage.sawWorldSortedAtReveal).toBe(true);

  const start = createRun({ seed, runLengthTarget: 7 });
  start.floor.activeMajorId = majorId;
  start.majors.claimed = [majorId];
  start.player.hp = 999;
  start.player.maxHp = 999;
  start.player.gold = 0;
  start.player.fate = 10;

  let replay = start;
  for (const a of actions) replay = applyAction(replay, a).nextState;

  return { start, actions, end: replay, coverage };
}

beforeAll(() => {
  const majors = JSON.parse(readFileSync(new URL("../../game-data/content/majors.json", import.meta.url), "utf8"));
  const strings = JSON.parse(readFileSync(new URL("../../game-data/content/strings.en.json", import.meta.url), "utf8"));
  majorsContent = majors;
  loadContent({ majors, strings });
});

describe("Phase D engine (majors via primitives)", () => {
  it.each(ALL_MAJORS)("replay is deterministic and exercises major: %s", (majorId) => {
    const seed = 9000 + ALL_MAJORS.indexOf(majorId);
    const first = runMajorReplay(majorId, seed);

    const start2 = createRun({ seed, runLengthTarget: 7 });
    start2.floor.activeMajorId = majorId;
    start2.majors.claimed = [majorId];
    start2.player.hp = 999;
    start2.player.maxHp = 999;
    start2.player.gold = 0;
    start2.player.fate = 10;

    let end2 = start2;
    for (const a of first.actions) end2 = applyAction(end2, a).nextState;

    expect(stripDebug(first.end)).toEqual(stripDebug(end2));
  });
});
