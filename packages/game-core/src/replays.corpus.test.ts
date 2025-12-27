import { readFileSync } from "node:fs";

import Ajv from "ajv/dist/2020.js";
import { beforeAll, describe, expect, it } from "vitest";

import { loadContent } from "./content.js";
import { replayActionLog } from "./replay.js";
import type { ActionLog } from "./replay.js";

type CorpusFile = {
  format: string;
  corpusVersion: number;
  createdAtUTC: string;
  engineVersion: string;
  contentVersion: string;
  specVersion: "v1.1";
  runs: any[];
};

beforeAll(() => {
  const majors = JSON.parse(readFileSync(new URL("../../game-data/content/majors.json", import.meta.url), "utf8"));
  const strings = JSON.parse(readFileSync(new URL("../../game-data/content/strings.en.json", import.meta.url), "utf8"));
  loadContent({ majors, strings });
});

describe("Phase F replay corpus", () => {
  it("contains 100+ runs and all runs match checkpoints", async () => {
    const corpus = JSON.parse(readFileSync(new URL("../../../replays/corpus_v1.json", import.meta.url), "utf8")) as CorpusFile;
    expect(corpus.format).toBe("fg-replay-corpus");
    expect(Array.isArray(corpus.runs)).toBe(true);
    expect(corpus.runs.length).toBeGreaterThanOrEqual(100);

    const schema = JSON.parse(readFileSync(new URL("../../game-data/schemas/action_log.schema.json", import.meta.url), "utf8"));
    const ajv = new Ajv({ strict: false, allErrors: true });
    const validate = ajv.compile(schema);

    for (const runUnknown of corpus.runs) {
      const ok = validate(runUnknown);
      if (!ok) throw new Error(`Action log schema validation failed: ${ajv.errorsText(validate.errors)}`);

      const run = runUnknown as ActionLog;
      const replay = await replayActionLog(run);
      for (const cp of run.checkpoints ?? []) {
        const got = replay.hashesByStep.get(cp.stepIndex);
        expect(got).toBe(cp.stateHash);
      }
    }
  }, 60_000);
});
