/**
 * Swap-based reduction: classic dynamic partial-order reduction
 * (Flanagan & Godefroid). Interleavings related by swapping adjacent
 * independent transitions form one equivalence class; the search explores
 * exactly the classes (at least one representative each) instead of every
 * interleaving, by maintaining backtrack sets along the current trace.
 */
import { Program } from './model';
import { ExploreResult, Finding, summarize, traceFromTids } from './explore';
import { trimFailingTrace } from './trim';
import {
  dependent, enabledThreads, initialState, isEnabled, isFinished,
  nextInstr, State, stateKey, step,
} from './state';
import { DEFAULT_BUDGET } from './full';

export function exploreDpor(program: Program, budget: number = DEFAULT_BUDGET): ExploreResult {
  const states: State[] = [initialState(program)];
  const tids: number[] = [];
  const backtrack: Array<Set<number>> = [];
  const done: Array<Set<number>> = [];
  const findings: Finding[] = [];
  const seenDeadlock = new Set<string>();
  let transitions = 0;
  let executions = 0;
  let truncated = false;

  function updateBacktrack(depth: number, p: number): void {
    // p's transition e_depth = (states[depth] -> states[depth+1]) was just
    // explored. For every earlier transition e_i on the current path (by a
    // different thread) that is dependent with e_depth, the reversed order
    // belongs to other equivalence classes, so p must also be explored from
    // the pre-state of e_i. If p is blocked there, conservatively add every
    // enabled thread (standard fallback for blocking locks).
    const instrP = nextInstr(program, states[depth], p)!;
    for (let i = depth - 1; i >= 0; i--) {
      const q = tids[i];
      if (q === p) continue;
      const si = states[i];
      if (!dependent(instrP, nextInstr(program, si, q)!)) continue;
      if (isEnabled(program, si, p)) {
        backtrack[i].add(p);
      } else {
        for (const r of enabledThreads(program, si)) backtrack[i].add(r);
      }
    }
  }

  function explore(depth: number): void {
    if (truncated) return;
    const s = states[depth];
    const enabled = enabledThreads(program, s);
    backtrack[depth] = new Set<number>();
    done[depth] = new Set<number>();

    // Blocked-thread propagation: a thread blocked on a mutex never emits
    // its lock transition, so the pair-based update cannot see the
    // dependency. Schedule it before every earlier conflicting mutex
    // operation on the current path.
    for (let t = 0; t < program.threads.length; t++) {
      const instr = nextInstr(program, s, t);
      if (instr === null || instr.op !== 'lock') continue;
      if (s.mutexOwner[instr.mutex] === -1) continue; // not blocked
      for (let i = depth - 1; i >= 0; i--) {
        const ei = nextInstr(program, states[i], tids[i])!;
        if (!dependent(instr, ei)) continue;
        if (isEnabled(program, states[i], t)) {
          backtrack[i].add(t);
        } else {
          for (const r of enabledThreads(program, states[i])) backtrack[i].add(r);
        }
      }
    }

    if (enabled.length === 0) {
      executions++;
      if (program.threads.some((_, t) => !isFinished(program, s, t))) {
        const key = stateKey(program, s);
        if (!seenDeadlock.has(key)) {
          seenDeadlock.add(key);
          findings.push({
            violation: { kind: 'deadlock', message: 'deadlock: every unfinished thread is blocked on a lock' },
            trace: traceFromTids(program, tids.slice(0, depth)),
          });
        }
      }
      return;
    }

    backtrack[depth].add(enabled[0]);
    for (;;) {
      let p = -1;
      for (const candidate of backtrack[depth]) {
        if (!done[depth].has(candidate)) { p = candidate; break; }
      }
      if (p === -1) return;
      done[depth].add(p);

      if (transitions >= budget) { truncated = true; return; }
      transitions++;
      const { next, violation } = step(program, s, p);
      tids[depth] = p;

      // A violation is recorded but does not stop the execution: truncating
      // here would hide violation events of other threads that belong to the
      // same equivalence class (and the backtrack points discovered beyond
      // them), breaking completeness of the shortest-error computation.
      if (violation !== null) {
        const trimmed = trimFailingTrace(program, tids.slice(0, depth + 1));
        findings.push({ violation, trace: traceFromTids(program, trimmed) });
      }
      states[depth + 1] = next;
      explore(depth + 1);
      if (truncated) return;
      updateBacktrack(depth, p);
    }
  }

  explore(0);
  return summarize(findings, { transitions, executions, truncated });
}
