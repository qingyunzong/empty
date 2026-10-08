// Two explorers over the interleaving space:
//
//  - exploreFull: plain DFS enumeration of every interleaving (no reduction).
//  - explorePor:  sleep-set partial-order reduction. Adjacent steps of
//    different threads that are independent (see sem.independent) commute, so
//    only one representative per Mazurkiewicz trace class is explored. Error
//    traces are additionally canonicalised by repeatedly swapping adjacent
//    independent steps, and duplicate classes are reported once.
//
// Programs are straight-line (no jumps), so the state space is acyclic and
// sleep sets alone preserve reachability of every state; in particular the
// shortest failing history has the same length in both modes (the length of
// any path to a state is fixed by its pc vector).

import { formatInstr, Instr, Program } from './lang.js';
import {
  applyStep,
  currentInstr,
  independent,
  initialState,
  isDone,
  isEnabled,
  State,
} from './sem.js';

export interface TraceStep {
  thread: number;
  pc: number;      // pc of the instruction before it executed
  instr: Instr;
  text: string;    // human readable, includes the shared value after the step
}

export interface ErrorTrace {
  steps: TraceStep[];
  error: string;
}

export interface ExploreStats {
  mode: 'full' | 'por';
  visited: number;      // DFS nodes visited
  executions: number;   // maximal executions (finished, failed or deadlocked)
  errorCount: number;   // failing executions found (full) or classes found (por)
  truncated: boolean;   // hit the visited cap
  errors: ErrorTrace[]; // stored traces (full: first MAX_STORED; por: one per class)
  shortest: ErrorTrace | null;
}

const MAX_STORED = 10000;

export const DEFAULT_MAX_VISITED = 2_000_000;

function makeStats(mode: 'full' | 'por'): ExploreStats {
  return {
    mode,
    visited: 0,
    executions: 0,
    errorCount: 0,
    truncated: false,
    errors: [],
    shortest: null,
  };
}

function enabledThreads(p: Program, s: State): number[] {
  const out: number[] = [];
  for (let t = 0; t < p.threads.length; t++) if (isEnabled(p, s, t)) out.push(t);
  return out;
}

function allDone(p: Program, s: State): boolean {
  for (let t = 0; t < p.threads.length; t++) if (!isDone(p, s, t)) return false;
  return true;
}

export function exploreFull(prog: Program, maxVisited = DEFAULT_MAX_VISITED): ExploreStats {
  const stats = makeStats('full');
  const trace: TraceStep[] = [];

  const recordError = (error: string) => {
    stats.errorCount++;
    const et: ErrorTrace = { steps: trace.slice(), error };
    if (stats.errors.length < MAX_STORED) stats.errors.push(et);
    if (!stats.shortest || et.steps.length < stats.shortest.steps.length) stats.shortest = et;
  };

  const dfs = (s: State): void => {
    if (stats.visited >= maxVisited) {
      stats.truncated = true;
      return;
    }
    stats.visited++;
    if (allDone(prog, s)) {
      stats.executions++;
      return;
    }
    const enabled = enabledThreads(prog, s);
    if (enabled.length === 0) {
      stats.executions++;
      recordError('deadlock: every thread is blocked or finished, but some thread is not done');
      return;
    }
    for (const t of enabled) {
      const ins = currentInstr(prog, s, t)!;
      const out = applyStep(prog, s, t);
      trace.push({
        thread: t,
        pc: s.pc[t],
        instr: ins,
        text: `t${t}#${s.pc[t]} ${formatInstr(ins)}   (x=${out.state.x})`,
      });
      if (out.error) {
        stats.executions++;
        recordError(out.error);
      } else {
        dfs(out.state);
      }
      trace.pop();
      if (stats.truncated) return;
    }
  };

  dfs(initialState(prog));
  return stats;
}

// Canonical representative of a trace class: bubble adjacent independent
// steps of a higher-numbered thread to the right until fixpoint.
export function canonicalOrder(steps: TraceStep[]): TraceStep[] {
  const arr = steps.slice();
  let swapped = true;
  while (swapped) {
    swapped = false;
    for (let i = 0; i + 1 < arr.length; i++) {
      const a = arr[i];
      const b = arr[i + 1];
      if (a.thread > b.thread && independent(a.instr, b.instr)) {
        arr[i] = b;
        arr[i + 1] = a;
        swapped = true;
      }
    }
  }
  return arr;
}

export function canonicalKey(steps: TraceStep[]): string {
  return canonicalOrder(steps)
    .map((s) => `${s.thread}:${s.pc}`)
    .join(' ');
}

export function explorePor(prog: Program, maxVisited = DEFAULT_MAX_VISITED): ExploreStats {
  const stats = makeStats('por');
  const trace: TraceStep[] = [];
  const classes = new Map<string, ErrorTrace>();

  const recordError = (error: string) => {
    const et: ErrorTrace = { steps: trace.slice(), error };
    const key = canonicalKey(et.steps);
    if (!classes.has(key)) {
      classes.set(key, et);
      stats.errorCount++;
      if (stats.errors.length < MAX_STORED) stats.errors.push(et);
    }
    if (!stats.shortest || et.steps.length < stats.shortest.steps.length) stats.shortest = et;
  };

  const dfs = (s: State, sleep: ReadonlySet<number>): void => {
    if (stats.visited >= maxVisited) {
      stats.truncated = true;
      return;
    }
    stats.visited++;
    if (allDone(prog, s)) {
      stats.executions++;
      return;
    }
    const enabled = enabledThreads(prog, s);
    if (enabled.length === 0) {
      stats.executions++;
      recordError('deadlock: every thread is blocked or finished, but some thread is not done');
      return;
    }
    const sleeping = new Set(sleep);
    for (const t of enabled) {
      if (sleeping.has(t)) continue;
      const ins = currentInstr(prog, s, t)!;
      const out = applyStep(prog, s, t);
      trace.push({
        thread: t,
        pc: s.pc[t],
        instr: ins,
        text: `t${t}#${s.pc[t]} ${formatInstr(ins)}   (x=${out.state.x})`,
      });
      if (out.error) {
        stats.executions++;
        recordError(out.error);
      } else {
        // Child sleep set: keep sleeping threads whose next instruction is
        // independent of the one just executed.
        const childSleep = new Set<number>();
        for (const u of sleeping) {
          const uIns = currentInstr(prog, s, u);
          if (uIns && independent(ins, uIns)) childSleep.add(u);
        }
        dfs(out.state, childSleep);
      }
      trace.pop();
      sleeping.add(t);
      if (stats.truncated) return;
    }
  };

  dfs(initialState(prog), new Set());
  return stats;
}
