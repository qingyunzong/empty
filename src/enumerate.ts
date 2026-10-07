import { constraintsSatisfied } from './problem.js';
import type { Assignment, Constraint, Problem } from './problem.js';

/**
 * - 'complete': the search finished; `samples` holds every solution found
 *   (for random sampling: the requested count was reached).
 * - 'unsatisfiable': the search finished and proved no solution exists.
 * - 'budget-exhausted': the search stopped early; unsatisfiability is NOT
 *   established, even if `samples` is empty.
 */
export type GenStatus = 'complete' | 'unsatisfiable' | 'budget-exhausted';

export interface GenResult {
  readonly status: GenStatus;
  readonly samples: Assignment[];
  /** Number of complete candidate assignments evaluated. */
  readonly examined: number;
}

export interface EnumerateOptions {
  /** Max number of complete candidate assignments to evaluate. Default: unlimited. */
  readonly budget?: number;
  /** Max number of samples to collect before stopping early. Default: unlimited. */
  readonly maxSamples?: number;
}

/** Total number of candidate assignments, capped at `cap`. */
export function spaceSize(problem: Problem, cap: number = Number.MAX_SAFE_INTEGER): number {
  let total = 1;
  for (const v of problem.variables) {
    total *= v.max - v.min + 1;
    if (total >= cap) return cap;
  }
  return total;
}

/**
 * Exact enumeration with constraint pruning: a constraint is checked as soon
 * as all variables it depends on are assigned, so invalid partial assignments
 * are cut off before their subtree is explored.
 */
export function enumerateSolutions(problem: Problem, options: EnumerateOptions = {}): GenResult {
  const budget = options.budget ?? Number.POSITIVE_INFINITY;
  const maxSamples = options.maxSamples ?? Number.POSITIVE_INFINITY;
  const vars = problem.variables;
  const indexOf = new Map(vars.map((v, i) => [v.name, i] as const));

  // Constraints with no dependencies decide satisfiability immediately.
  const active: Constraint[] = [];
  for (const c of problem.constraints) {
    if (c.vars.length === 0) {
      if (!c.check(() => { throw new Error('constraint has no variables'); })) {
        return { status: 'unsatisfiable', samples: [], examined: 0 };
      }
    } else {
      active.push(c);
    }
  }

  // Trigger each constraint as soon as its last dependency is assigned.
  const triggers: Constraint[][] = vars.map(() => []);
  for (const c of active) {
    let last = -1;
    for (const name of c.vars) last = Math.max(last, indexOf.get(name) as number);
    (triggers[last] as Constraint[]).push(c);
  }

  const values: number[] = new Array(vars.length).fill(0);
  const assigned = new Set<string>();
  const get = (name: string): number => values[indexOf.get(name) as number] as number;
  const samples: Assignment[] = [];
  let examined = 0;
  let stoppedEarly = false;

  function dfs(i: number): void {
    if (stoppedEarly) return;
    if (i === vars.length) {
      if (examined >= budget || samples.length >= maxSamples) {
        stoppedEarly = true;
        return;
      }
      examined++;
      const sample: Record<string, number> = {};
      for (let j = 0; j < vars.length; j++) sample[(vars[j] as { name: string }).name] = values[j] as number;
      samples.push(Object.freeze(sample));
      return;
    }
    const v = vars[i] as { name: string; min: number; max: number };
    assigned.add(v.name);
    for (let val = v.min; val <= v.max; val++) {
      values[i] = val;
      if ((triggers[i] as Constraint[]).every((c) => c.check(get))) dfs(i + 1);
      if (stoppedEarly) break;
    }
    assigned.delete(v.name);
  }

  dfs(0);

  const status: GenStatus = stoppedEarly
    ? 'budget-exhausted'
    : samples.length === 0
      ? 'unsatisfiable'
      : 'complete';
  return { status, samples, examined };
}

/** Cross-check helper: full cartesian product filtered by `satisfies`, no pruning. */
export function bruteForceSolutions(problem: Problem): Assignment[] {
  const vars = problem.variables;
  const out: Assignment[] = [];
  const values: number[] = new Array(vars.length).fill(0);
  function dfs(i: number): void {
    if (i === vars.length) {
      const sample: Record<string, number> = {};
      for (let j = 0; j < vars.length; j++) sample[(vars[j] as { name: string }).name] = values[j] as number;
      if (constraintsSatisfied(problem.constraints, (name) => sample[name] as number)) {
        out.push(Object.freeze(sample));
      }
      return;
    }
    const v = vars[i] as { name: string; min: number; max: number };
    for (let val = v.min; val <= v.max; val++) {
      values[i] = val;
      dfs(i + 1);
    }
  }
  dfs(0);
  return out;
}
