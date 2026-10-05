/** Shared result types and helpers for the explorations. */
import { formatInstr, Program } from './model';
import { Violation } from './state';

export interface TraceStep {
  tid: number;
  threadName: string;
  instrText: string;
}

export interface Finding {
  violation: Violation;
  trace: TraceStep[]; // history leading to (and including) the violating step
}

export interface ExploreStats {
  transitions: number;   // executed steps
  states?: number;       // visited states (full exploration)
  executions?: number;   // maximal executions explored (DPOR)
  truncated: boolean;    // step budget exhausted
}

export interface ExploreResult {
  verdict: 'SAFE' | 'UNSAFE' | 'INCOMPLETE';
  findings: Finding[];
  shortestError: TraceStep[] | null;
  stats: ExploreStats;
}

/** Reconstruct the instruction history for a sequence of thread choices. */
export function traceFromTids(program: Program, tids: number[]): TraceStep[] {
  const pcs = program.threads.map(() => 0);
  return tids.map(tid => {
    const instr = program.threads[tid].instrs[pcs[tid]++];
    return { tid, threadName: program.threads[tid].name, instrText: formatInstr(instr) };
  });
}

export function summarize(findings: Finding[], stats: ExploreStats): ExploreResult {
  let shortestError: TraceStep[] | null = null;
  for (const f of findings) {
    if (shortestError === null || f.trace.length < shortestError.length) {
      shortestError = f.trace;
    }
  }
  const verdict = stats.truncated ? 'INCOMPLETE' : findings.length === 0 ? 'SAFE' : 'UNSAFE';
  return { verdict, findings, shortestError, stats };
}

/**
 * Exact number of interleavings of the program's instructions (multinomial
 * coefficient). This is the size of the uncompressed stateless exploration
 * (executions); each execution has at most `totalInstrs` steps.
 */
export function interleavingCount(program: Program): bigint {
  let result = 1n;
  let n = 0;
  for (const t of program.threads) {
    for (let i = 1; i <= t.instrs.length; i++) {
      n++;
      result = (result * BigInt(n)) / BigInt(i);
    }
  }
  return result;
}

export function totalInstrs(program: Program): number {
  return program.threads.reduce((acc, t) => acc + t.instrs.length, 0);
}
