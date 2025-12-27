import type { GameEvent, MinorCard, MinorRank, Orientation, RunState } from "./types.js";

export function isNumbered(rank: MinorRank): rank is Extract<MinorRank, { kind: "number" }> {
  return rank.kind === "number";
}

export function isCourt(card: MinorCard): card is MinorCard & { rank: Extract<MinorRank, { kind: "court" }> } {
  return card.rank.kind === "court";
}

export function computeMinorNumericValue(rank: Extract<MinorRank, { kind: "number" }>) {
  return rank.value;
}

export function computeEnemyValue(card: MinorCard, effectiveOrientation: Orientation): number {
  if (card.rank.kind !== "court") throw new Error("Not a court card");
  const base = card.rank.face === "page" ? 11 : card.rank.face === "knight" ? 12 : card.rank.face === "queen" ? 13 : 14;
  return effectiveOrientation === "reversed" ? base + 2 : base;
}

export function computeEffectiveOrientation(state: RunState, slotIndex: number, card: MinorCard): Orientation {
  let eff: Orientation = card.orientation;
  if (state.floor.bossMode && isNumbered(card.rank)) eff = "reversed";
  if (state.room.pendingCleanses[slotIndex]) eff = "upright";
  return eff;
}

export function applyArmorIfAny(state: RunState, amount: number, events: GameEvent[]): number {
  if (amount <= 0) return 0;
  const armor = state.player.armor;
  if (!armor) return amount;
  const reduced = Math.max(0, amount - armor.value);
  if (reduced !== amount) {
    state.player.armor = null;
    events.push({ type: "DISCARD_EQUIPMENT", kind: "armor", cardId: armor.cardId });
    state.floor.floorDiscard.push(armor.cardId);
  }
  return reduced;
}
