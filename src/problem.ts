import type { Assignment, Constraint, IntVar, Problem } from './types.js';

export class ProblemError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ProblemError';
  }
}

/**
 * Validate and freeze a problem definition.
 *
 * Rejects: duplicate variable names, non-integer or inverted bounds, and
 * constraints that declare variables not present in the problem.
 */
export function defineProblem(spec: {
  vars: readonly IntVar[];
  constraints?: readonly Constraint[];
}): Problem {
  const seen = new Set<string>();
  for (const v of spec.vars) {
    if (seen.has(v.name)) {
      throw new ProblemError(`duplicate variable: ${v.name}`);
    }
    seen.add(v.name);
    if (!Number.isInteger(v.min) || !Number.isInteger(v.max)) {
      throw new ProblemError(`variable ${v.name}: bounds must be integers`);
    }
    if (v.min > v.max) {
      throw new ProblemError(`variable ${v.name}: min ${v.min} > max ${v.max}`);
    }
  }
  const constraints = spec.constraints ?? [];
  for (const c of constraints) {
    const missing = c.vars.filter((name) => !seen.has(name));
    if (missing.length > 0) {
      const label = c.name ?? '<unnamed>';
      throw new ProblemError(
        `constraint ${label} references missing variable(s): ${missing.join(', ')}`,
      );
    }
  }
  return {
    vars: spec.vars.map((v) => ({ ...v })),
    constraints: constraints.slice(),
  };
}

/** True when every declared variable is assigned and all constraints hold. */
export function isValidAssignment(problem: Problem, assignment: Assignment): boolean {
  for (const v of problem.vars) {
    const value = assignment[v.name];
    if (value === undefined || !Number.isInteger(value) || value < v.min || value > v.max) {
      return false;
    }
  }
  return problem.constraints.every((c) => c.check(assignment));
}

/** Constraints whose declared variables are all assigned in `partial`. */
export function applicableConstraints(
  problem: Problem,
  partial: Assignment,
): readonly Constraint[] {
  return problem.constraints.filter((c) =>
    c.vars.every((name) => partial[name] !== undefined),
  );
}

/** Check only the constraints that are fully determined by `partial`. */
export function consistentPartial(problem: Problem, partial: Assignment): boolean {
  return applicableConstraints(problem, partial).every((c) => c.check(partial));
}
