import { readFileSync } from "node:fs";

import { beforeAll, describe, expect, it } from "vitest";

import { loadContent } from "./content.js";
import { applyAction, createRun, getLegalActions } from "./engine.js";
import type { CardId, MinorCard, RunState } from "./types.js";

function makeCard(id: CardId, suit: MinorCard["suit"], rank: MinorCard["rank"], orientation: MinorCard["orientation"]): MinorCard {
  return { id, suit, rank, orientation };
}

beforeAll(() => {
  const majors = JSON.parse(readFileSync(new URL("../../game-data/content/majors.json", import.meta.url), "utf8"));
  const strings = JSON.parse(readFileSync(new URL("../../game-data/content/strings.en.json", import.meta.url), "utf8"));
  loadContent({ majors, strings });
});

function baseState(overrides: Partial<RunState>): RunState {
  const state = createRun({ seed: 1, runLengthTarget: 7 });
  return { ...state, ...overrides };
}

function withRoom(
  overrides: Partial<RunState>,
  room: {
    slots: [CardId | null, CardId | null, CardId | null, CardId | null];
    pendingCleanses?: [boolean, boolean, boolean, boolean];
    resolvedMask?: [boolean, boolean, boolean, boolean];
  },
  cards: MinorCard[],
  deck: CardId[] = []
): RunState {
  const s = baseState(overrides);
  // Stabilize unit tests: majors/shadows are covered separately in Phase D replay tests.
  s.floor.activeMajorId = "magician";
  const minors: Record<string, MinorCard> = {};
  for (const c of cards) minors[c.id] = c;
  s.decks.cards.minors = minors;
  s.decks.minorDeck = [...deck];
  s.room.slots = [...room.slots] as any;
  s.room.pendingCleanses = (room.pendingCleanses ?? [false, false, false, false]) as any;
  s.room.resolvedMask = (room.resolvedMask ?? [false, false, false, false]) as any;
  s.phase = "PreResolveWindow";
  s.debug = {};
  return s;
}

function step(s: RunState, action: any) {
  return applyAction(s, action).nextState;
}

describe("Phase B engine (rooms + minors)", () => {
  it("enforces per-room healing limiter across multiple Cups", () => {
    const cups2 = makeCard("cups_2", "cups", { kind: "number", value: 2 }, "upright");
    const cups3 = makeCard("cups_3", "cups", { kind: "number", value: 3 }, "upright");
    const pent2 = makeCard("pentacles_2", "pentacles", { kind: "number", value: 2 }, "upright");
    const pent3 = makeCard("pentacles_3", "pentacles", { kind: "number", value: 3 }, "upright");

    const s0 = withRoom(
      {
        player: {
          hp: 10,
          maxHp: 20,
          gold: 0,
          fate: 0,
          weapon: null,
          armor: null,
          spell: null,
          buffs: { cheatWeaponNextEnemyFight: false, cheatWeaponThisRoom: false }
        }
      },
      { slots: ["cups_2", "cups_3", "pentacles_2", "pentacles_3"] },
      [cups2, cups3, pent2, pent3]
    );

    const s1 = step(s0, { type: "COMMIT_RESOLVE", slotIndex: 0 });
    expect(s1.player.hp).toBe(12);

    const s2 = step(s1, { type: "COMMIT_RESOLVE", slotIndex: 1 });
    expect(s2.player.hp).toBe(12);
  });

  it("applies reversed Pentacles loss with remainder as damage and grants Fate", () => {
    const pent7 = makeCard("pentacles_7", "pentacles", { kind: "number", value: 7 }, "reversed");
    const filler = makeCard("cups_2", "cups", { kind: "number", value: 2 }, "upright");

    const s0 = withRoom(
      {
        player: {
          hp: 20,
          maxHp: 20,
          gold: 3,
          fate: 0,
          weapon: null,
          armor: null,
          spell: null,
          buffs: { cheatWeaponNextEnemyFight: false, cheatWeaponThisRoom: false }
        }
      },
      { slots: ["pentacles_7", "cups_2", null, null] },
      [pent7, filler]
    );

    const s1 = step(s0, { type: "COMMIT_RESOLVE", slotIndex: 0 });
    expect(s1.player.gold).toBe(0);
    expect(s1.player.hp).toBe(16);
    expect(s1.player.fate).toBe(1);
  });

  it("tracks weapon restriction using last helped defeat value (elite included)", () => {
    const sword5 = makeCard("swords_5", "swords", { kind: "number", value: 5 }, "upright");
    const queen = makeCard("cups_queen", "cups", { kind: "court", face: "queen" }, "upright");
    const king = makeCard("cups_king", "cups", { kind: "court", face: "king" }, "upright");
    const filler = makeCard("pentacles_2", "pentacles", { kind: "number", value: 2 }, "upright");
    const fill3 = makeCard("pentacles_3", "pentacles", { kind: "number", value: 3 }, "upright");
    const fill4 = makeCard("pentacles_4", "pentacles", { kind: "number", value: 4 }, "upright");
    const fill5 = makeCard("pentacles_5", "pentacles", { kind: "number", value: 5 }, "upright");

    const s0 = withRoom(
      {
        player: {
          hp: 50,
          maxHp: 50,
          gold: 0,
          fate: 0,
          weapon: null,
          armor: null,
          spell: null,
          buffs: { cheatWeaponNextEnemyFight: false, cheatWeaponThisRoom: false }
        }
      },
      { slots: ["swords_5", "cups_queen", "cups_king", "pentacles_2"] },
      [sword5, queen, king, filler, fill3, fill4, fill5],
      ["pentacles_3", "pentacles_4", "pentacles_5"]
    );

    const s1 = step(s0, { type: "COMMIT_RESOLVE", slotIndex: 0 });
    expect(s1.player.weapon?.value).toBe(5);

    const s2 = step(s1, { type: "COMMIT_RESOLVE", slotIndex: 1 });
    const legal2 = getLegalActions(s2);
    expect(legal2.some((a) => a.type === "ENEMY_FIGHT_CHOICE" && a.enemyMode === "weapon")).toBe(true);
    const s3 = step(s2, { type: "ENEMY_FIGHT_CHOICE", enemyMode: "weapon" });
    expect(s3.player.weapon?.lastHelpedDefeatValue).toBe(13);

    const s4 = step(s3, { type: "COMMIT_RESOLVE", slotIndex: 2 });
    expect(s4.player.weapon?.lastHelpedDefeatValue).toBe(13);
    expect(s4.player.hp).toBe(28);
  });

  it("Leap of Faith flips and applies immediate Fate/HP effect", () => {
    const c = makeCard("pentacles_2", "pentacles", { kind: "number", value: 2 }, "upright");
    const s0 = withRoom({}, { slots: ["pentacles_2", null, null, null] }, [c]);
    const s1 = step(s0, { type: "USE_LEAP_OF_FAITH", slotIndex: 0 });
    expect(s1.player.fate).toBe(2);
  });

  it("Swords ambush can be blocked by weapon value", () => {
    const ambush = makeCard("swords_8", "swords", { kind: "number", value: 8 }, "reversed");
    const weapon = makeCard("swords_5", "swords", { kind: "number", value: 5 }, "upright");
    const s0 = withRoom(
      {
        player: {
          hp: 20,
          maxHp: 20,
          gold: 0,
          fate: 0,
          weapon: { cardId: "swords_5", value: 5, lastHelpedDefeatValue: null, tuckedEnemyIds: [] },
          armor: null,
          spell: null,
          buffs: { cheatWeaponNextEnemyFight: false, cheatWeaponThisRoom: false }
        }
      },
      { slots: ["swords_8", null, null, null] },
      [ambush, weapon]
    );

    const s1 = step(s0, { type: "COMMIT_RESOLVE", slotIndex: 0 });
    const legal = getLegalActions(s1);
    expect(legal.some((a) => a.type === "SWORDS_AMBUSH_BLOCK_CHOICE")).toBe(true);
    const s2 = step(s1, { type: "SWORDS_AMBUSH_BLOCK_CHOICE", block: true });
    expect(s2.player.hp).toBe(17);
  });

  it("can auto-simulate several rooms deterministically without crashing", () => {
    let s = createRun({ seed: 42, runLengthTarget: 7 });
    s.floor.activeMajorId = "magician";
    s.player.hp = 999;
    s.player.maxHp = 999;
    s.player.gold = 999;
    s.player.fate = 10;

    let steps = 0;
    let roomsCompleted = 0;
    let lastEngagedRoomsCompleted = s.floor.engagedRoomsCompleted;
    while (steps < 500 && roomsCompleted < 5) {
      const legal = getLegalActions(s);
      if (legal.length === 0) throw new Error(`No legal actions at phase=${s.phase}`);

      // Basic policy: always engage; for prompts choose first option; always commit the first legal resolve slot.
      let chosen = legal[0]!;
      const engage = legal.find((a) => a.type === "CHOOSE_ENGAGE");
      if (engage) chosen = engage;
      const commit = legal.find((a) => a.type === "COMMIT_RESOLVE");
      if (commit) chosen = commit;
      const fightWeapon = legal.find((a) => a.type === "ENEMY_FIGHT_CHOICE" && a.enemyMode === "weapon");
      if (fightWeapon) chosen = fightWeapon;

      s = step(s, chosen);
      steps += 1;

      if (s.floor.engagedRoomsCompleted > lastEngagedRoomsCompleted) {
        roomsCompleted += s.floor.engagedRoomsCompleted - lastEngagedRoomsCompleted;
        lastEngagedRoomsCompleted = s.floor.engagedRoomsCompleted;
      }
      if (s.phase === "RunDefeat") break;
    }

    expect(roomsCompleted).toBeGreaterThanOrEqual(1);
  });
});
