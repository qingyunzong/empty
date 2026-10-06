/** A finite integer parameter with inclusive bounds. */
export interface IntVar {
  readonly name: string;
  readonly min: number;
  readonly max: number;
}

/** A total assignment of every variable to an integer value. */
export type Assignment = Readonly<Record<string, number>>;

/**
 * A constraint over a subset of variables.
 *
 * `vars` declares the variables `check` reads; a problem is rejected at
 * construction time if any declared variable is missing from the problem.
 */
export interface Constraint {
  readonly name?: string;
  readonly vars: readonly string[];
  readonly check: (values: Assignment) => boolean;
}

export interface Problem {
  readonly vars: readonly IntVar[];
  readonly constraints: readonly Constraint[];
}

/** Limits that may cut a search short before it finishes. */
export interface Budget {
  /** Maximum number of search nodes (assignment attempts) to visit. */
  readonly maxNodes?: number;
  /** Stop after collecting this many solutions. */
  readonly maxSolutions?: number;
}

/**
 * - `complete`: the request was fully served (enumeration finished, or the
 *   requested number of samples was produced).
 * - `unsatisfiable`: the whole search space was explored and no solution exists.
 * - `incomplete`: the budget ran out before the search finished; `samples`
 *   holds whatever was found so far and nothing is proven.
 */
export type SolveStatus = 'complete' | 'unsatisfiable' | 'incomplete';

export interface SolveResult {
  readonly status: SolveStatus;
  readonly samples: readonly Assignment[];
  readonly nodesVisited: number;
}
