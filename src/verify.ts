import { execute, type ExecutionSummary } from './executor.ts';
import { classify, expectedStarted } from './model.ts';
import type { TestCase } from './graph.ts';

export interface Mismatch {
  readonly id: string;
  readonly executor: string;
  readonly model: string;
}

export interface Verification {
  readonly ok: boolean;
  readonly summary: ExecutionSummary;
  readonly startedMatch: boolean;
  readonly mismatches: readonly Mismatch[];
}

/**
 * Cross-check the controllable executor against the full-graph
 * classification model: the started sets must be equal and every
 * per-test status must agree.
 */
export function verifyAgainstModel(
  cases: readonly TestCase[],
  outcome: (id: string) => boolean,
): Verification {
  const summary = execute(cases, outcome);
  const model = classify(cases, outcome);
  const modelStarted = expectedStarted(cases, outcome);

  const startedMatch =
    summary.started.length === modelStarted.size &&
    summary.started.every((id) => modelStarted.has(id));

  const mismatches: Mismatch[] = [];
  for (const r of summary.results) {
    const m = model.get(r.id)!;
    if (m !== r.status) mismatches.push({ id: r.id, executor: r.status, model: m });
  }
  return { ok: startedMatch && mismatches.length === 0, summary, startedMatch, mismatches };
}
