import { buildDepMap, findIsolated, type TestCase } from './graph.ts';
import type { TestStatus } from './executor.ts';

/**
 * Full-graph classification model: given the same graph and an outcome
 * oracle, classifies every test in one pass over the whole graph. Used to
 * cross-check the executor's started set and per-test statuses.
 */
export function classify(
  cases: readonly TestCase[],
  outcome: (id: string) => boolean,
): Map<string, TestStatus> {
  const depMap = buildDepMap(cases);
  const isolated = findIsolated(depMap);
  const memo = new Map<string, TestStatus>();

  function resolve(id: string): TestStatus {
    const cached = memo.get(id);
    if (cached !== undefined) return cached;
    let result: TestStatus;
    if (isolated.has(id)) {
      result = 'isolated';
    } else if (depMap.get(id)!.some((d) => resolve(d) !== 'passed')) {
      result = 'cancelled';
    } else {
      result = outcome(id) ? 'passed' : 'failed';
    }
    memo.set(id, result);
    return result;
  }

  for (const id of depMap.keys()) resolve(id);
  return memo;
}

/** Ids the model expects the executor to start (passed or failed). */
export function expectedStarted(
  cases: readonly TestCase[],
  outcome: (id: string) => boolean,
): Set<string> {
  const classified = classify(cases, outcome);
  const started = new Set<string>();
  for (const [id, s] of classified) {
    if (s === 'passed' || s === 'failed') started.add(id);
  }
  return started;
}
