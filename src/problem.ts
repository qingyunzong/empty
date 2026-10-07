export interface VariableDef {
  readonly name: string;
  readonly min: number;
  readonly max: number;
}

export type Assignment = Readonly<Record<string, number>>;

export type ValueGetter = (name: string) => number;

export interface Constraint {
  readonly name?: string;
  /** Variables this constraint depends on. Every name must exist in the problem. */
  readonly vars: readonly string[];
  readonly check: (get: ValueGetter) => boolean;
}

export interface Problem {
  readonly variables: readonly VariableDef[];
  readonly constraints: readonly Constraint[];
}

export class UnknownVariableError extends Error {
  readonly missing: readonly string[];
  constructor(missing: readonly string[]) {
    const unique = [...new Set(missing)];
    super(`constraint depends on unknown variable(s): ${unique.join(', ')}`);
    this.name = 'UnknownVariableError';
    this.missing = unique;
  }
}

export class InvalidProblemError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidProblemError';
  }
}

/**
 * Builds a validated problem. Rejects duplicate variables, non-integer or
 * inverted bounds, and constraints that depend on variables not declared in
 * the schema (UnknownVariableError).
 */
export function defineProblem(input: {
  variables: readonly VariableDef[];
  constraints?: readonly Constraint[];
}): Problem {
  const variables = input.variables ?? [];
  const constraints = input.constraints ?? [];
  const known = new Set<string>();

  for (const v of variables) {
    if (typeof v.name !== 'string' || v.name.length === 0) {
      throw new InvalidProblemError('variable name must be a non-empty string');
    }
    if (known.has(v.name)) {
      throw new InvalidProblemError(`duplicate variable: ${v.name}`);
    }
    known.add(v.name);
    if (!Number.isInteger(v.min) || !Number.isInteger(v.max)) {
      throw new InvalidProblemError(`variable ${v.name}: bounds must be integers`);
    }
    if (v.min > v.max) {
      throw new InvalidProblemError(`variable ${v.name}: min (${v.min}) > max (${v.max})`);
    }
  }

  const missing: string[] = [];
  for (const c of constraints) {
    if (c === null || typeof c !== 'object' || !Array.isArray(c.vars) || typeof c.check !== 'function') {
      throw new InvalidProblemError('constraint must provide vars: string[] and check: function');
    }
    for (const name of c.vars) {
      if (!known.has(name)) missing.push(name);
    }
  }
  if (missing.length > 0) throw new UnknownVariableError(missing);

  return { variables: [...variables], constraints: [...constraints] };
}

/**
 * Evaluates constraints against a (possibly partial) assignment. When
 * `assigned` is given, constraints whose dependencies are not fully assigned
 * yet are skipped; this is what allows safe pruning during enumeration.
 */
export function constraintsSatisfied(
  constraints: readonly Constraint[],
  get: ValueGetter,
  assigned?: ReadonlySet<string>,
): boolean {
  for (const c of constraints) {
    if (assigned !== undefined && !c.vars.every((name) => assigned.has(name))) continue;
    if (!c.check(get)) return false;
  }
  return true;
}

/** Full validity check: in-domain integer values plus all constraints. */
export function satisfies(problem: Problem, assignment: Assignment): boolean {
  for (const v of problem.variables) {
    const value = assignment[v.name];
    if (value === undefined || !Number.isInteger(value) || value < v.min || value > v.max) {
      return false;
    }
  }
  return constraintsSatisfied(problem.constraints, (name) => assignment[name] as number);
}
