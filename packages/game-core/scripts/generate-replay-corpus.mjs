import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

import { applyAction, createRun, getLegalActions, hashRunState, loadContent } from "../dist/index.js";

const repoRoot = resolve(import.meta.dirname, "../../..");
const replaysDir = resolve(repoRoot, "replays");
const outFile = resolve(replaysDir, "corpus_v1.json");

const majors = JSON.parse(readFileSync(resolve(repoRoot, "packages/game-data/content/majors.json"), "utf8"));
const strings = JSON.parse(readFileSync(resolve(repoRoot, "packages/game-data/content/strings.en.json"), "utf8"));
loadContent({ majors, strings });

const enginePkg = JSON.parse(readFileSync(resolve(repoRoot, "packages/game-core/package.json"), "utf8"));

function chooseAction(state) {
  const legal = getLegalActions(state);
  if (legal.length === 0) throw new Error(`No legal actions at phase=${state.phase}`);

  if (state.phase === "FloorStart") {
    let best = legal[0];
    for (const a of legal) {
      if (a.type === "SELECT_ATTUNEMENT") {
        if (a.majorIds.length > best.majorIds.length) best = a;
      }
    }
    return best;
  }

  const majorGift = legal.find((a) => a.type === "USE_MAJOR_GIFT");
  if (majorGift) return majorGift;

  const engage = legal.find((a) => a.type === "CHOOSE_ENGAGE");
  if (engage) return engage;

  const carried = legal.find((a) => a.type === "SELECT_CARRIED_CARD");
  if (carried) return carried;

  const commit = legal.find((a) => a.type === "COMMIT_RESOLVE");
  if (commit) return commit;

  const enemyWeapon = legal.find((a) => a.type === "ENEMY_FIGHT_CHOICE" && a.enemyMode === "weapon");
  if (enemyWeapon) return enemyWeapon;

  const swordsBlock = legal.find((a) => a.type === "SWORDS_AMBUSH_BLOCK_CHOICE" && a.block);
  if (swordsBlock) return swordsBlock;

  const cupsHeal = legal.find((a) => a.type === "CUPS_8_10_CHOICE" && a.cupsChoice === "heal");
  if (cupsHeal) return cupsHeal;

  const reorderTop3 = legal.find((a) => a.type === "REORDER_TOP3" && JSON.stringify(a.order) === JSON.stringify([0, 1, 2]));
  if (reorderTop3) return reorderTop3;

  const reorderRoom4 = legal.find((a) => a.type === "REORDER_ROOM4" && JSON.stringify(a.order) === JSON.stringify([0, 1, 2, 3]));
  if (reorderRoom4) return reorderRoom4;

  const ace = legal.find((a) => a.type === "ACE_CHOICE");
  if (ace) {
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

  return legal[0];
}

function nowFixedUTC() {
  return "2025-12-27T00:00:00.000Z";
}

const RUNS = 120;
const corpus = {
  format: "fg-replay-corpus",
  corpusVersion: 1,
  createdAtUTC: nowFixedUTC(),
  engineVersion: enginePkg.version,
  contentVersion: majors.contentVersion,
  specVersion: "v1.1",
  runs: []
};

for (let i = 0; i < RUNS; i += 1) {
  const seed = 10_000 + i;
  const runLengthTarget = 7;
  let state = createRun({ seed, runLengthTarget });

  const actions = [{ type: "START_RUN", seed, runLengthTarget }];
  const checkpoints = [];

  checkpoints.push({ stepIndex: 0, stateHash: await hashRunState(state) });

  for (let step = 0; step < 450; step += 1) {
    if (state.phase === "RunVictory" || state.phase === "RunDefeat") break;
    const action = chooseAction(state);
    actions.push(action);
    state = applyAction(state, action).nextState;
    if (actions.length % 10 === 0) checkpoints.push({ stepIndex: actions.length - 1, stateHash: await hashRunState(state) });
  }

  corpus.runs.push({
    header: {
      engineVersion: enginePkg.version,
      contentVersion: majors.contentVersion,
      specVersion: "v1.1",
      createdAtUTC: nowFixedUTC()
    },
    seed,
    actions,
    checkpoints
  });
}

mkdirSync(replaysDir, { recursive: true });
writeFileSync(outFile, JSON.stringify(corpus, null, 2));
console.log(`Wrote ${RUNS} runs → ${outFile}`);

