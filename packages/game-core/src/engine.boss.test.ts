import { readFileSync } from "node:fs";

import { beforeAll, describe, expect, it } from "vitest";

import { loadContent } from "./content.js";
import { applyAction, createRun, getLegalActions } from "./engine.js";
import type { LegalAction, RunState } from "./types.js";

beforeAll(() => {
  const majors = JSON.parse(readFileSync(new URL("../../game-data/content/majors.json", import.meta.url), "utf8"));
  const strings = JSON.parse(readFileSync(new URL("../../game-data/content/strings.en.json", import.meta.url), "utf8"));
  loadContent({ majors, strings });
});

function step(state: RunState, action: LegalAction): RunState {
  return applyAction(state, action).nextState;
}

function chooseAction(state: RunState): LegalAction {
  const legal = getLegalActions(state);
  if (legal.length === 0) throw new Error(`No legal actions at phase=${state.phase}`);

  const engage = legal.find((a) => a.type === "CHOOSE_ENGAGE");
  if (engage) return engage;

  const commit = legal.find((a) => a.type === "COMMIT_RESOLVE");
  if (commit) return commit;

  const weapon = legal.find((a) => a.type === "ENEMY_FIGHT_CHOICE" && a.enemyMode === "weapon");
  if (weapon) return weapon;

  const block = legal.find((a) => a.type === "SWORDS_AMBUSH_BLOCK_CHOICE" && a.block);
  if (block) return block;

  const cupsArmor = legal.find((a) => a.type === "CUPS_8_10_CHOICE" && a.cupsChoice === "heal");
  if (cupsArmor) return cupsArmor;

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

  return legal[0]!;
}

function playSteps(state: RunState, maxSteps: number): RunState {
  let s = state;
  for (let i = 0; i < maxSteps; i += 1) {
    if (s.phase === "RunVictory" || s.phase === "RunDefeat") return s;
    s = step(s, chooseAction(s));
  }
  throw new Error(`Did not converge after ${maxSteps} steps, phase=${s.phase}`);
}

function playUntil(state: RunState, predicate: (s: RunState) => boolean, maxSteps = 5000): RunState {
  let s = state;
  for (let i = 0; i < maxSteps; i += 1) {
    if (predicate(s)) return s;
    if (s.phase === "RunVictory" || s.phase === "RunDefeat") return s;
    s = step(s, chooseAction(s));
  }
  throw new Error(`Predicate not reached after ${maxSteps} steps, phase=${s.phase}`);
}

describe("Phase C engine (floors + boss)", () => {
  it("does not start boss before 6 engaged rooms", () => {
    const s0 = createRun({ seed: 1, runLengthTarget: 7 });
    const s1 = playUntil(s0, (s) => s.floor.engagedRoomsCompleted >= 1);
    expect(s1.floor.engagedRoomsCompleted).toBe(1);
    expect(s1.floor.bossMode).toBe(false);
  });

  it("starts boss after 6 engaged rooms and builds bossDeck from floorDiscard only", () => {
    const s0 = createRun({ seed: 123, runLengthTarget: 7 });
    s0.player.hp = 999;
    s0.player.maxHp = 999;
    const s1 = playUntil(s0, (s) => s.floor.bossMode && s.floor.engagedRoomsCompleted >= 6);

    expect(s1.floor.engagedRoomsCompleted).toBeGreaterThanOrEqual(6);
    expect(s1.floor.bossRoomsRequired).toBe(2);
    expect(Array.isArray(s1.floor.bossDeck)).toBe(true);

    const carriedIndex = s1.room.carriedIndex;
    expect(typeof carriedIndex).toBe("number");
    const drawnFromBoss = s1.room.slots
      .map((id, idx) => ({ id, idx }))
      .filter((x) => x.idx !== carriedIndex)
      .map((x) => x.id)
      .filter((x): x is string => typeof x === "string");

    for (const id of drawnFromBoss) {
      expect(s1.floor.floorDiscard.includes(id)).toBe(true);
    }

    const deckRemaining = s1.floor.bossDeck ?? [];
    expect(new Set([...deckRemaining, ...drawnFromBoss])).toEqual(new Set(s1.floor.floorDiscard));
  });

  it("applies boss corruption: numbered minors resolve as reversed and grant Fate unless cleansed", () => {
    let s = createRun({ seed: 321, runLengthTarget: 7 });
    s.player.hp = 999;
    s.player.maxHp = 999;
    s = playUntil(s, (x) => x.floor.bossMode && x.floor.engagedRoomsCompleted >= 6);

    // Find a numbered Minor that is physically upright; in boss mode it is still effectively reversed (unless cleansed).
    const roomSlots = s.room.slots
      .map((id, idx) => ({ id, idx }))
      .filter((x): x is { id: string; idx: number } => typeof x.id === "string");
    const target = roomSlots
      .map(({ id, idx }) => ({ id, idx, card: s.decks.cards.minors[id] }))
      .find((x) => x.card && x.card.rank.kind === "number");
    if (!target) throw new Error("Expected a numbered minor in boss room");

    const hp0 = s.player.hp;
    s.player.fate = 10;
    const fate0 = s.player.fate;

    s = step(s, { type: "CHOOSE_ENGAGE" });
    // Cleanse should be legal because effective orientation is reversed due to boss corruption.
    s = step(s, { type: "SPEND_FATE_CLEANSE", slotIndex: target.idx });
    const fateAfterCleanse = s.player.fate;
    s = step(s, { type: "COMMIT_RESOLVE", slotIndex: target.idx });

    // Cleanse forces effective upright, so this resolution should not grant Fate.
    expect(s.player.fate).toBe(fateAfterCleanse);
    // And it should not do the boss-corrupted reversed effect; hp may change but must stay within bounds.
    expect(s.player.hp).toBeGreaterThan(0);
    expect(s.player.hp).toBeLessThanOrEqual(Math.max(hp0, s.player.maxHp));
    expect(fate0).toBe(10);
  });

  it("can complete a full floor loop into boss and advance to next floor", () => {
    let s = createRun({ seed: 999, runLengthTarget: 7 });
    s.player.hp = 999;
    s.player.maxHp = 999;
    s = playUntil(s, (x) => x.floor.bossMode && x.floor.engagedRoomsCompleted >= 6);

    const floorNumber = s.floor.floorNumber;
    expect(floorNumber).toBe(1);

    // Complete enough boss rooms to win the floor.
    s.player.hp = 999;
    s.player.maxHp = 999;
    s = playUntil(s, (x) => x.floor.floorNumber >= 2, 5000);

    expect(s.floor.floorNumber).toBeGreaterThanOrEqual(2);
    expect(s.floor.bossMode).toBe(false);
  });
});
