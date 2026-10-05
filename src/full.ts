/**
 * Uncompressed exploration: BFS over all interleavings with visited-state
 * deduplication. Serves as the reference for the reduced exploration.
 */
import { Program } from './model';
import { ExploreResult, Finding, summarize, traceFromTids } from './explore';
import { trimFailingTrace } from './trim';
import {
  enabledThreads, initialState, isDeadlock, isFinished, State, stateKey, step,
} from './state';

export const DEFAULT_BUDGET = 5_000_000;

export function exploreFull(program: Program, budget: number = DEFAULT_BUDGET): ExploreResult {
  const start = initialState(program);
  const visited = new Set<string>([stateKey(program, start)]);
  const queue: { state: State; tids: number[] }[] = [{ state: start, tids: [] }];
  const findings: Finding[] = [];
  const seenDeadlock = new Set<string>();
  let transitions = 0;
  let truncated = false;

  while (queue.length > 0) {
    const { state, tids } = queue.shift()!;
    const enabled = enabledThreads(program, state);
    if (enabled.length === 0 && program.threads.some((_, t) => !isFinished(program, state, t))) {
      const key = stateKey(program, state);
      if (!seenDeadlock.has(key)) {
        seenDeadlock.add(key);
        findings.push({
          violation: { kind: 'deadlock', message: 'deadlock: every unfinished thread is blocked on a lock' },
          trace: traceFromTids(program, tids),
        });
      }
    }
    for (const tid of enabled) {
      if (transitions >= budget) { truncated = true; break; }
      transitions++;
      const { next, violation } = step(program, state, tid);
      if (violation !== null) {
        const trimmed = trimFailingTrace(program, [...tids, tid]);
        findings.push({ violation, trace: traceFromTids(program, trimmed) });
      }
      // Violations do not stop the execution (same semantics as the DPOR
      // exploration); the successor state is explored as usual.
      const key = stateKey(program, next);
      if (!visited.has(key)) {
        visited.add(key);
        queue.push({ state: next, tids: [...tids, tid] });
      }
    }
    if (truncated) break;
  }

  return summarize(findings, { transitions, states: visited.size, truncated });
}
