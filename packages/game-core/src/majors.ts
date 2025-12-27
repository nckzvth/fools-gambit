import type { EffectNode, HookId, Selector } from "./content.js";
import { getLoadedContent } from "./content.js";
import type { CardId, LegalAction, MajorId, MinorCard, RunState } from "./types.js";
import { computeEffectiveOrientation, computeEnemyValue, computeMinorNumericValue, isCourt, isNumbered } from "./rules.js";

function permutations<T>(items: T[]): T[][] {
  if (items.length <= 1) return [items];
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += 1) {
    const head = items[i]!;
    const rest = items.slice(0, i).concat(items.slice(i + 1));
    for (const tail of permutations(rest)) out.push([head, ...tail]);
  }
  return out;
}

type MajorPrompt =
  | { kind: "CHOICE"; majorId: MajorId; promptKey: string; optionIds: string[]; optionEffects: EffectNode[] }
  | { kind: "BARGAIN"; majorId: MajorId; promptKey: string; options: ("pay" | "takeDamage")[]; bargainOptions: NonNullable<EffectNode["bargainOptions"]> }
  | { kind: "REORDER_TOP3"; majorId: MajorId }
  | { kind: "REORDER_ROOM4"; majorId: MajorId }
  | { kind: "SELECT_TARGET"; majorId: MajorId; effect: EffectNode; candidates: number[] };

function getMajor(majorId: MajorId) {
  return getLoadedContent().majorById[majorId];
}

export function getFloorMajorShadow(state: RunState, hook: HookId): EffectNode | null {
  const major = getMajor(state.floor.activeMajorId);
  if (major.shadow.trigger !== hook) return null;
  return major.shadow.effect;
}

function roomHasEnemy(state: RunState): boolean {
  return state.room.slots.some((id) => {
    if (!id) return false;
    const card = state.decks.cards.minors[id];
    return Boolean(card && card.rank.kind === "court");
  });
}

function roomHasAnyEffectiveReversed(state: RunState): boolean {
  return state.room.slots.some((id, idx) => {
    if (!id) return false;
    const card = state.decks.cards.minors[id];
    if (!card) return false;
    return computeEffectiveOrientation(state, idx, card) === "reversed";
  });
}

function computeOrderingValue(state: RunState, slotIndex: number, card: MinorCard): number {
  const eff = computeEffectiveOrientation(state, slotIndex, card);
  if (card.rank.kind === "ace") return 1;
  if (card.rank.kind === "number") return computeMinorNumericValue(card.rank);
  return computeEnemyValue(card, eff);
}

function selectorCandidates(state: RunState, selector: Selector): number[] {
  const occupied = [0, 1, 2, 3].filter((i) => state.room.slots[i] !== null);

  if (selector.kind === "LEFTMOST") return occupied.length ? [Math.min(...occupied)] : [];

  if (selector.kind === "IF_ENEMY_PRESENT_PLAYER_CHOICE") return roomHasEnemy(state) ? occupied : [];

  if (selector.kind === "IF_ANY_REVERSED_PLAYER_CHOICE") {
    const candidates = occupied.filter((i) => {
      const id = state.room.slots[i]!;
      const card = state.decks.cards.minors[id]!;
      return computeEffectiveOrientation(state, i, card) === "reversed";
    });
    return candidates;
  }

  if (selector.kind === "HIGHEST_VALUE") {
    const scored = occupied
      .map((i) => {
        const id = state.room.slots[i]!;
        const card = state.decks.cards.minors[id]!;
        return { i, v: computeOrderingValue(state, i, card) };
      })
      .sort((a, b) => b.v - a.v || a.i - b.i);
    if (scored.length === 0) return [];
    const max = scored[0]!.v;
    return scored.filter((x) => x.v === max).map((x) => x.i);
  }

  return occupied;
}

export function beginMajorEffectPrompt(state: RunState, majorId: MajorId, effect: EffectNode): void {
  // Stores prompt detail into debug; engine will expose legal actions from it and apply in applyAction handlers.
  const dbg = (state.debug ??= {});
  if (dbg.pendingPrompt) throw new Error("Cannot begin major prompt while another prompt is pending");

  if (effect.type === "CHOICE") {
    if (!effect.promptKey || !effect.options) throw new Error("CHOICE requires promptKey and options");
    dbg.pendingPrompt = {
      kind: "MAJOR_CHOICE",
      majorId,
      promptKey: effect.promptKey,
      optionIds: effect.options.map((o) => o.labelKey)
    };
    // Store full prompt in a non-hashed field for follow-up.
    (dbg as any).pendingMajorPrompt = {
      kind: "CHOICE",
      majorId,
      promptKey: effect.promptKey,
      optionIds: effect.options.map((o) => o.labelKey),
      optionEffects: effect.options.map((o) => o.effect)
    } satisfies MajorPrompt;
    return;
  }

  if (effect.type === "BARGAIN") {
    if (!effect.promptKey || !effect.options || !effect.bargainOptions) throw new Error("BARGAIN requires promptKey/options/bargainOptions");
    if (effect.options.length !== effect.bargainOptions.length) throw new Error("BARGAIN options and bargainOptions length mismatch");
    const simplified = effect.bargainOptions.map((o) => ("payGold" in o ? "pay" : "takeDamage")) as ("pay" | "takeDamage")[];
    dbg.pendingPrompt = { kind: "MAJOR_BARGAIN", majorId, promptKey: effect.promptKey, options: simplified };
    (dbg as any).pendingMajorPrompt = {
      kind: "BARGAIN",
      majorId,
      promptKey: effect.promptKey,
      options: simplified,
      bargainOptions: effect.bargainOptions
    } satisfies MajorPrompt;
    return;
  }

  if (effect.type === "REORDER_TOP_N") {
    dbg.pendingPrompt = { kind: "MAJOR_REORDER_TOP3", majorId };
    (dbg as any).pendingMajorPrompt = { kind: "REORDER_TOP3", majorId } satisfies MajorPrompt;
    return;
  }

  if (effect.type === "REORDER_ROOM_ARBITRARY") {
    dbg.pendingPrompt = { kind: "MAJOR_REORDER_ROOM4", majorId };
    (dbg as any).pendingMajorPrompt = { kind: "REORDER_ROOM4", majorId } satisfies MajorPrompt;
    return;
  }

  if (effect.type === "REROLL_REVEALED" || effect.type === "EXILE_REPLACE_REVEALED" || effect.type === "CLEANSE_REVEALED") {
    if (!effect.selector) throw new Error(`${effect.type} requires selector`);
    const candidates = selectorCandidates(state, effect.selector);
    if (candidates.length === 0) return;
    if (effect.selector.kind === "RANDOM") {
      // Handled by engine directly; no prompt.
      return;
    }
    if (effect.selector.kind === "HIGHEST_VALUE" && candidates.length === 1) return;
    dbg.pendingPrompt = { kind: "MAJOR_CHOICE", majorId, promptKey: "major.selectTarget", optionIds: candidates.map((i) => String(i)) };
    (dbg as any).pendingMajorPrompt = { kind: "SELECT_TARGET", majorId, effect, candidates } satisfies MajorPrompt;
    return;
  }

  throw new Error(`Unsupported major prompt type: ${effect.type}`);
}

export function getMajorPrompt(state: RunState): MajorPrompt | null {
  const p = (state.debug as any)?.pendingMajorPrompt as MajorPrompt | undefined;
  return p ?? null;
}

export function clearMajorPrompt(state: RunState) {
  if (!state.debug) return;
  delete (state.debug as any).pendingMajorPrompt;
  delete state.debug.pendingPrompt;
}

export function getMajorPromptLegalActions(state: RunState): LegalAction[] {
  const prompt = getMajorPrompt(state);
  if (!prompt) return [];

  if (prompt.kind === "CHOICE") {
    return prompt.optionIds.map((optionId) => ({ type: "USE_MAJOR_GIFT", majorId: prompt.majorId, optionId }));
  }

  if (prompt.kind === "BARGAIN") {
    const out: Array<Extract<LegalAction, { type: "BARGAIN_CHOICE" }>> = [];
    for (let i = 0; i < prompt.options.length; i += 1) {
      const kind = prompt.options[i]!;
      const opt = prompt.bargainOptions[i]!;
      if (kind === "pay") {
        const payGold = opt.payGold ?? 0;
        if (state.player.gold < payGold) continue;
      }
      out.push({ type: "BARGAIN_CHOICE", bargainChoice: kind });
    }
    const seen = new Set<string>();
    return out.filter((a) => {
      const key = a.bargainChoice;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    }) satisfies LegalAction[];
  }

  if (prompt.kind === "REORDER_TOP3") return permutations([0, 1, 2]).map((order) => ({ type: "REORDER_TOP3", order }));
  if (prompt.kind === "REORDER_ROOM4") return permutations([0, 1, 2, 3]).map((order) => ({ type: "REORDER_ROOM4", order }));

  if (prompt.kind === "SELECT_TARGET") {
    return prompt.candidates.map((slotIndex) => ({ type: "USE_MAJOR_GIFT", majorId: prompt.majorId, slotIndex }));
  }

  return [];
}

export function isMajorEffectActive(state: RunState, hook: HookId): boolean {
  return getFloorMajorShadow(state, hook) !== null;
}
