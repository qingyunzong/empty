import { makeFold, type Journal, type PlanStep } from "./model.js";
import { inversePlan } from "./plan.js";
import { requireJournal } from "./journal.js";
import { RealView, VirtualView, consumedNames, reconcileStep } from "./recover.js";

export interface VerifyReport {
  ok: boolean;
  checks: string[];
  problems: string[];
}

function cloneSteps(steps: PlanStep[]): PlanStep[] {
  return steps.map((s) => ({ ...s }));
}

interface RecoveryRun {
  actions: number;
  problems: string[];
}

function runRecovery(steps: PlanStep[], view: VirtualView, consumed: Set<string>): RecoveryRun {
  const problems: string[] = [];
  let actions = 0;
  for (const step of steps) {
    const outcome = reconcileStep(step, view, consumed);
    if ("problem" in outcome) {
      problems.push(outcome.problem);
      continue;
    }
    if (outcome.action === "skip") continue;
    actions++;
    if (outcome.action === "execute") view.rename(step.from, step.to);
    step.status = "done";
  }
  return { actions, problems };
}

function sortedFolded(names: string[], fold: (s: string) => string): string[] {
  return names.map(fold).sort();
}

function sameNames(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  return a.every((v, i) => v === b[i]);
}

export function verifyJournal(dir: string): VerifyReport {
  const journal: Journal = requireJournal(dir);
  const fold = makeFold(journal.caseFold);
  const checks: string[] = [];
  const problems: string[] = [];
  const consumed = consumedNames(journal.steps, fold);

  journal.steps.forEach((step, i) => {
    if (step.index !== i) problems.push(`step index mismatch at position ${i}`);
  });
  checks.push(`structure: ${journal.steps.length} steps, indexes sequential`);

  const realView = new RealView(fold);
  const mentioned = new Set<string>([...journal.initial, ...journal.final]);
  for (const step of journal.steps) {
    mentioned.add(step.from);
    mentioned.add(step.to);
  }
  const present: string[] = [];
  for (const name of mentioned) {
    const actual = realView.resolveExisting(name);
    if (actual !== null) present.push(actual);
  }
  const live = runRecovery(cloneSteps(journal.steps), new VirtualView(fold, present), consumed);
  if (live.problems.length > 0) {
    problems.push(...live.problems.map((p) => `live filesystem: ${p}`));
  } else {
    checks.push(
      live.actions === 0
        ? "live filesystem: consistent with journal, no recovery actions needed"
        : `live filesystem: consistent; ${live.actions} recovery action(s) would finish the batch`,
    );
  }

  const expectedFinal = sortedFolded(journal.final, fold);
  const expectedInitial = sortedFolded(journal.initial, fold);

  let crashPointsChecked = 0;
  for (let k = 0; k <= journal.steps.length; k++) {
    for (const window of ["after-doing", "after-rename"] as const) {
      const steps = cloneSteps(journal.steps);
      const view = new VirtualView(fold, journal.initial);
      for (let i = 0; i < k; i++) {
        const step = steps[i];
        if (!step) continue;
        view.rename(step.from, step.to);
        step.status = "done";
      }
      for (let i = k; i < steps.length; i++) {
        const step = steps[i];
        if (step) step.status = "pending";
      }
      const interrupted = steps[k];
      if (interrupted) {
        interrupted.status = "doing";
        if (window === "after-rename") view.rename(interrupted.from, interrupted.to);
      }
      const first = runRecovery(steps, view, consumed);
      if (first.problems.length > 0) {
        problems.push(`recovery from crash point ${k} (${window}): ${first.problems.join("; ")}`);
        continue;
      }
      if (!sameNames(view.snapshot(), expectedFinal)) {
        problems.push(`recovery from crash point ${k} (${window}): final state mismatch`);
        continue;
      }
      const second = runRecovery(steps, view, consumed);
      if (second.problems.length > 0 || second.actions !== 0) {
        problems.push(`second recovery from crash point ${k} (${window}) was not a no-op`);
        continue;
      }
      crashPointsChecked++;
    }
  }
  checks.push(`recovery twice: ${crashPointsChecked} simulated crash points recovered, second pass always a no-op`);

  const undoView = new VirtualView(fold, journal.final);
  const undo = inversePlan(journal.steps);
  let inverseOk = true;
  for (const step of undo) {
    if (!undoView.has(step.from) || (undoView.has(step.to) && !undoView.sameFile(step.from, step.to))) {
      inverseOk = false;
      problems.push(`inverse plan conflict at ${step.from} -> ${step.to}`);
      break;
    }
    undoView.rename(step.from, step.to);
  }
  if (inverseOk) {
    if (sameNames(undoView.snapshot(), expectedInitial)) {
      checks.push("inverse plan: replaying all steps backwards restores the initial state");
    } else {
      problems.push("inverse plan: final state after rollback does not match the initial state");
    }
  }

  return { ok: problems.length === 0, checks, problems };
}
