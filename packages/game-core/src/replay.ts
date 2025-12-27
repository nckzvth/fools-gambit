import type { EngineConfig, LegalAction, RunState } from "./types.js";
import { applyAction, createRun } from "./engine.js";
import { hashRunState } from "./stateHash.js";

export type ActionLogHeader = {
  engineVersion: string;
  contentVersion: string;
  specVersion: "v1.1";
  createdAtUTC: string;
};

export type StartRunAction = { type: "START_RUN"; seed: number; runLengthTarget: 7 | 14 | 21 };

export type ActionLog = {
  header: ActionLogHeader;
  seed: number;
  actions: Array<StartRunAction | LegalAction>;
  checkpoints?: Array<{ stepIndex: number; stateHash: string }>;
};

export async function replayActionLog(log: ActionLog): Promise<{ endState: RunState; hashesByStep: Map<number, string> }> {
  if (!log.actions.length) throw new Error("Action log missing actions");
  const first = log.actions[0];
  if (!first || (first as any).type !== "START_RUN") throw new Error("Action log must start with START_RUN");
  const start = first as StartRunAction;

  const config: EngineConfig = { seed: start.seed, runLengthTarget: start.runLengthTarget };
  let state = createRun(config);

  const hashesByStep = new Map<number, string>();
  hashesByStep.set(0, await hashRunState(state));

  for (let i = 1; i < log.actions.length; i += 1) {
    const a = log.actions[i] as LegalAction;
    state = applyAction(state, a).nextState;
    hashesByStep.set(i, await hashRunState(state));
  }

  return { endState: state, hashesByStep };
}

