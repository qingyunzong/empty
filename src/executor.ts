import { renameSync } from "node:fs";
import { makeFold, type PlanStep } from "./model.js";
import { requireJournal, saveJournal } from "./journal.js";
import { RealView, consumedNames, reconcileStep } from "./recover.js";

export class RecoveryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RecoveryError";
  }
}

export interface ExecHooks {
  afterDoing?: (step: PlanStep) => void;
  afterStep?: (step: PlanStep) => void;
  log?: (line: string) => void;
}

export interface ExecResult {
  executed: number;
  skipped: number;
  recovered: number;
}

export function execute(dir: string, hooks: ExecHooks = {}): ExecResult {
  const journal = requireJournal(dir);
  const fold = makeFold(journal.caseFold);
  const view = new RealView(fold);
  const consumed = consumedNames(journal.steps, fold);
  const result: ExecResult = { executed: 0, skipped: 0, recovered: 0 };

  for (const step of journal.steps) {
    const outcome = reconcileStep(step, view, consumed);
    if ("problem" in outcome) {
      saveJournal(journal);
      throw new RecoveryError(outcome.problem);
    }
    if (outcome.action === "skip") {
      result.skipped++;
      continue;
    }
    if (outcome.action === "mark-done") {
      step.status = "done";
      saveJournal(journal);
      result.recovered++;
      hooks.log?.(`recovered step ${step.index}: ${step.from} -> ${step.to}`);
      continue;
    }
    const wasDoing = step.status === "doing";
    step.status = "doing";
    saveJournal(journal);
    hooks.afterDoing?.(step);
    const actualFrom = view.resolveExisting(step.from) ?? step.from;
    renameSync(actualFrom, step.to);
    step.status = "done";
    saveJournal(journal);
    if (wasDoing) result.recovered++;
    result.executed++;
    hooks.log?.(`renamed step ${step.index}: ${step.from} -> ${step.to}`);
    hooks.afterStep?.(step);
  }
  return result;
}
