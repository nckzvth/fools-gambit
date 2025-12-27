import { readFileSync } from "node:fs";

import { beforeAll, describe, expect, it } from "vitest";

import { loadContent } from "./content.js";
import { applyAction, createRun, getLegalActions } from "./engine.js";
import { Xorshift32 } from "./rng/xorshift32.js";
import { hashRunState } from "./stateHash.js";
import type { LegalAction, RunState } from "./types.js";

function chooseFuzzAction(state: RunState, chooser: Xorshift32): LegalAction {
  const legal = getLegalActions(state);
  if (legal.length === 0) {
    const pendingPromptKind = state.debug?.pendingPrompt?.kind ?? "none";
    const hasPendingMajorPrompt = Boolean((state.debug as any)?.pendingMajorPrompt);
    throw new Error(
      `No legal actions at phase=${state.phase} pendingPrompt=${pendingPromptKind} pendingMajorPrompt=${hasPendingMajorPrompt} order=${state.rules.orderConstraint.kind} requiresChooseCarriedFirst=${state.rules.orderConstraint.requiresChooseCarriedFirst} carriedIndex=${state.room.carriedIndex} carryChoiceIndex=${state.room.carryChoiceIndex} resolvedMask=${JSON.stringify(state.room.resolvedMask)} slots=${JSON.stringify(state.room.slots)}`
    );
  }

  // Filter out known invalid choices that can still be legal-listed (Ace of Pentacles "pay5_heal5").
  const filtered = legal.filter((a) => {
    if (a.type !== "ACE_CHOICE") return true;
    if (a.optionId !== "pay5_heal5") return true;
    return state.player.gold >= 5;
  });
  const list = filtered.length ? filtered : legal;
  return list[chooser.nextUint32() % list.length]!;
}

function assertInvariants(state: RunState) {
  expect(state.player.maxHp).toBeGreaterThanOrEqual(1);
  expect(state.player.hp).toBeGreaterThanOrEqual(0);
  expect(state.player.hp).toBeLessThanOrEqual(state.player.maxHp);
  expect(state.player.fate).toBeGreaterThanOrEqual(0);
  expect(state.player.fate).toBeLessThanOrEqual(state.fateCap);
  expect(state.fateCap).toBe(10);

  expect(state.majors.attuned.length).toBeLessThanOrEqual(3);
  expect(new Set(state.majors.claimed).size).toBe(state.majors.claimed.length);
  expect(new Set(state.majors.attuned).size).toBe(state.majors.attuned.length);
  expect(new Set(state.majors.spentThisFloor).size).toBe(state.majors.spentThisFloor.length);
  for (const id of state.majors.attuned) expect(state.majors.claimed.includes(id)).toBe(true);

  expect(state.room.slots.length).toBe(4);
  expect(state.room.resolvedMask.length).toBe(4);
  expect(state.room.pendingCleanses.length).toBe(4);
  expect(state.room.disabledFateActionsThisRoom.every((x) => x === "CLEANSE" || x === "REROLL")).toBe(true);
}

beforeAll(() => {
  const majors = JSON.parse(readFileSync(new URL("../../game-data/content/majors.json", import.meta.url), "utf8"));
  const strings = JSON.parse(readFileSync(new URL("../../game-data/content/strings.en.json", import.meta.url), "utf8"));
  loadContent({ majors, strings });
});

describe("Phase F invariants fuzz", () => {
  it("holds invariants and is deterministic under identical action selection", async () => {
    for (let seed = 1; seed <= 30; seed += 1) {
      const chooserSeed = 100_000 + seed;

      const runOnce = async () => {
        let s = createRun({ seed, runLengthTarget: 7 });
        const chooser = new Xorshift32(chooserSeed);
        for (let i = 0; i < 600; i += 1) {
          assertInvariants(s);
          if (s.phase === "RunVictory" || s.phase === "RunDefeat") break;
          const a = chooseFuzzAction(s, chooser);
          s = applyAction(s, a).nextState;
        }
        assertInvariants(s);
        return hashRunState(s);
      };

      const h1 = await runOnce();
      const h2 = await runOnce();
      expect(h1).toBe(h2);
    }
  }, 60_000);
});
