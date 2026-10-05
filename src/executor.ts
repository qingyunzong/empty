import { buildDepMap, findIsolated, type TestCase } from './graph.ts';

export type TestStatus = 'passed' | 'failed' | 'cancelled' | 'isolated';

export interface TestResult {
  readonly id: string;
  readonly status: TestStatus;
}

export interface ExecutionSummary {
  /** All results, stably sorted by test id. */
  readonly results: readonly TestResult[];
  /** Ids of tests actually started, sorted by id. */
  readonly started: readonly string[];
}

function byId(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * Controllable executor: the caller supplies `run`, which executes a test
 * and returns true on pass. A failed test cancels its transitive dependents
 * only; unrelated siblings keep running. Cyclic SCCs and their dependents
 * are isolated up front and never started.
 */
export function execute(
  cases: readonly TestCase[],
  run: (id: string) => boolean,
): ExecutionSummary {
  const depMap = buildDepMap(cases);
  const isolated = findIsolated(depMap);
  const status = new Map<string, TestStatus>();
  const pending = new Set<string>();
  for (const id of depMap.keys()) {
    if (isolated.has(id)) status.set(id, 'isolated');
    else pending.add(id);
  }

  const started: string[] = [];
  while (pending.size > 0) {
    const ready = [...pending]
      .filter((id) => depMap.get(id)!.every((d) => status.has(d)))
      .sort(byId);
    if (ready.length === 0) {
      throw new Error(`unresolvable tests remain: ${[...pending].sort(byId).join(', ')}`);
    }
    for (const id of ready) {
      const blocked = depMap
        .get(id)!
        .some((d) => status.get(d) !== 'passed');
      if (blocked) {
        status.set(id, 'cancelled');
      } else {
        started.push(id);
        status.set(id, run(id) ? 'passed' : 'failed');
      }
      pending.delete(id);
    }
  }

  const results = [...status.entries()]
    .map(([id, s]) => ({ id, status: s }))
    .sort((a, b) => byId(a.id, b.id));
  started.sort(byId);
  return { results, started };
}
