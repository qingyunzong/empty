import * as fs from "node:fs";
import { randomUUID } from "node:crypto";
import { buildPlan, invertRenames, PreflightError } from "./plan.js";
import { appendEntry, journalPath, readJournal } from "./journal.js";
import { RecoveryError, runSteps, RunResult, StepHook } from "./execute.js";
import { MappingFile, Plan } from "./types.js";

export interface ApplyResult extends RunResult {
  plan: Plan;
  alreadyComplete: boolean;
}

/** Preflight, persist the plan, then execute it step by step. */
export function applyMapping(dir: string, mapping: MappingFile, caseFold: boolean, hook?: StepHook): ApplyResult {
  const state = readJournal(dir);
  if (state.plan && !state.done) {
    throw new RecoveryError("an incomplete plan is journaled; run `photo-rename recover` before applying a new mapping");
  }
  const plan = buildPlan(dir, mapping, caseFold);
  if (fs.existsSync(journalPath(dir))) {
    fs.renameSync(journalPath(dir), journalPath(dir) + `.${state.plan!.id}.archived`);
  }
  appendEntry(dir, {
    type: "plan",
    id: randomUUID(),
    caseFold,
    renames: plan.renames,
    steps: plan.steps,
    createdAt: new Date().toISOString(),
  });
  const result = runSteps(dir, plan.steps, new Set<number>(), (index, recovered) => {
    appendEntry(dir, { type: "step", index, ...(recovered ? { recovered: true } : {}) });
  }, hook);
  appendEntry(dir, { type: "done" });
  return { ...result, plan, alreadyComplete: false };
}

export interface RecoverResult extends RunResult {
  status: "no-journal" | "already-complete" | "recovered";
}

/** Resume an interrupted plan. Safe to run any number of times. */
export function recover(dir: string, hook?: StepHook): RecoverResult {
  const state = readJournal(dir);
  if (!state.plan) return { applied: 0, recovered: 0, skipped: 0, status: "no-journal" };
  if (state.done) return { applied: 0, recovered: 0, skipped: state.plan.steps.length, status: "already-complete" };
  const result = runSteps(dir, state.plan.steps, state.completedSteps, (index, recovered) => {
    appendEntry(dir, { type: "step", index, ...(recovered ? { recovered: true } : {}) });
  }, hook);
  appendEntry(dir, { type: "done" });
  return { ...result, status: "recovered" };
}

export interface UndoResult extends RunResult {
  status: "nothing-to-undo" | "already-undone" | "undone";
  inverseSteps: number;
}

/** Apply the inverse plan derived from the journal to restore original names. */
export function undo(dir: string, hook?: StepHook): UndoResult {
  const state = readJournal(dir);
  if (!state.plan || !state.done) {
    return { applied: 0, recovered: 0, skipped: 0, status: "nothing-to-undo", inverseSteps: 0 };
  }
  if (state.undoDone) {
    return { applied: 0, recovered: 0, skipped: state.undoPlan?.steps.length ?? 0, status: "already-undone", inverseSteps: 0 };
  }
  const inverseMapping: MappingFile = { caseFold: state.plan.caseFold, renames: invertRenames(state.plan.renames) };
  // Re-plan the inverse against current disk state: validates everything and
  // reuses cycle-breaking, so the inverse of a cycle is also safe.
  const inversePlan = buildPlan(dir, inverseMapping, state.plan.caseFold);
  const steps = state.undoPlan?.steps ?? inversePlan.steps;
  if (!state.undoPlan) {
    appendEntry(dir, { type: "undo-plan", steps, createdAt: new Date().toISOString() });
  }
  const result = runSteps(dir, steps, state.completedUndoSteps, (index, recovered) => {
    appendEntry(dir, { type: "undo-step", index, ...(recovered ? { recovered: true } : {}) });
  }, hook);
  appendEntry(dir, { type: "undo-done" });
  return { ...result, status: "undone", inverseSteps: steps.length };
}

/** Check that the mapping's final state holds on disk. Returns problems (empty = OK). */
export function verify(dir: string, mapping: MappingFile, caseFold: boolean): string[] {
  const problems: string[] = [];
  const fold = (s: string) => (caseFold ? s.toLowerCase() : s);
  const listing = fs.readdirSync(dir);
  const present = new Set(listing.map(fold));
  const targetFolds = new Set((mapping.renames ?? []).map((r) => fold(r.to)));
  for (const r of mapping.renames ?? []) {
    if (!present.has(fold(r.to))) problems.push(`missing target: "${r.to}"`);
    if (fold(r.from) !== fold(r.to) && !targetFolds.has(fold(r.from)) && present.has(fold(r.from))) {
      problems.push(`source still present: "${r.from}"`);
    }
  }
  return problems;
}

export { PreflightError, RecoveryError };
