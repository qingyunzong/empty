/**
 * Independent brute-force enumerator used to cross-check the solver.
 *
 * Deliberately shares no propagation/search code with solver.ts: it walks the
 * plain Cartesian product of the domains and tests each constraint directly
 * on full (or partial) assignments.
 */

import { Constraint, Decision, Problem, validateProblem } from './solver.js';

function tupleKey(values: number[]): string {
  return values.join(',');
}

function constraintHolds(
  c: Constraint,
  tupleSets: (Set<string> | null)[],
  index: number,
  assignment: number[],
): boolean {
  if (c.kind === 'allDifferent') {
    const seen = new Set<number>();
    for (const v of c.variables) {
      const val = assignment[v];
      if (seen.has(val)) return false;
      seen.add(val);
    }
    return true;
  }
  const key = tupleKey(c.variables.map((v) => assignment[v]));
  return (tupleSets[index] as Set<string>).has(key);
}

function buildTupleSets(problem: Problem): (Set<string> | null)[] {
  return problem.constraints.map((c) =>
    c.kind === 'table' ? new Set(c.tuples.map(tupleKey)) : null,
  );
}

/** Full-assignment checker: membership in domains plus every constraint. */
export function checkAssignment(problem: Problem, assignment: number[]): boolean {
  validateProblem(problem);
  if (assignment.length !== problem.domains.length) return false;
  for (let i = 0; i < assignment.length; i++) {
    if (!problem.domains[i].includes(assignment[i])) return false;
  }
  const tupleSets = buildTupleSets(problem);
  return problem.constraints.every((c, i) => constraintHolds(c, tupleSets, i, assignment));
}

export interface EnumerationResult {
  count: number;
  solutions: number[][];
  /** True when the enumeration stopped early because of `limit`. */
  truncated: boolean;
}

/** Enumerate all solutions by Cartesian product (optionally capped by limit). */
export function enumerateSolutions(problem: Problem, limit = Number.POSITIVE_INFINITY): EnumerationResult {
  validateProblem(problem);
  const tupleSets = buildTupleSets(problem);
  const solutions: number[][] = [];
  const current: number[] = new Array(problem.domains.length);
  let stopped = false;

  const rec = (i: number): void => {
    if (stopped) return;
    if (solutions.length >= limit) {
      stopped = true;
      return;
    }
    if (i === problem.domains.length) {
      for (let ci = 0; ci < problem.constraints.length; ci++) {
        if (!constraintHolds(problem.constraints[ci], tupleSets, ci, current)) return;
      }
      solutions.push([...current]);
      return;
    }
    for (const value of problem.domains[i]) {
      current[i] = value;
      rec(i + 1);
      if (stopped) return;
    }
  };
  rec(0);
  return { count: solutions.length, solutions, truncated: stopped };
}

/**
 * Partial-assignment consistency, checked independently of the solver:
 *  - allDifferent: no two assigned variables in scope share a value;
 *  - table: some allowed tuple agrees with every assigned variable in scope.
 */
export function isPartialConsistent(problem: Problem, path: Decision[]): boolean {
  validateProblem(problem);
  const assigned = new Map<number, number>();
  for (const d of path) {
    if (assigned.has(d.variable)) return false;
    if (!problem.domains[d.variable].includes(d.value)) return false;
    assigned.set(d.variable, d.value);
  }
  for (const c of problem.constraints) {
    if (c.kind === 'allDifferent') {
      const seen = new Set<number>();
      for (const v of c.variables) {
        const val = assigned.get(v);
        if (val === undefined) continue;
        if (seen.has(val)) return false;
        seen.add(val);
      }
    } else {
      const ok = c.tuples.some((tuple) =>
        c.variables.every((v, i) => {
          const val = assigned.get(v);
          return val === undefined || tuple[i] === val;
        }),
      );
      if (!ok) return false;
    }
  }
  return true;
}
