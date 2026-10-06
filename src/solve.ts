import { consistentPartial } from './problem.js';
import { createRng, shuffled } from './rng.js';
import type { Assignment, Budget, Problem, SolveResult } from './types.js';

interface SearchOptions {
  readonly maxNodes?: number;
  readonly maxSolutions?: number;
  /**
   * When true, reaching `maxSolutions` means the request was fulfilled
   * (status `complete`); when false it is a budget cap (status `incomplete`).
   */
  readonly solutionsAreTarget?: boolean;
  /** Optional domain shuffler for randomized (but seed-deterministic) search. */
  readonly order?: (values: readonly number[]) => readonly number[];
}

function domainValues(min: number, max: number): number[] {
  const values: number[] = [];
  for (let v = min; v <= max; v++) values.push(v);
  return values;
}

function search(problem: Problem, options: SearchOptions): SolveResult {
  const domains = problem.vars.map((v) => {
    const values = domainValues(v.min, v.max);
    return options.order ? options.order(values) : values;
  });
  const samples: Assignment[] = [];
  let nodesVisited = 0;
  let cutShort = false;
  let fulfilled = false;

  const budgetHit = (): boolean => {
    if (options.maxSolutions !== undefined && samples.length >= options.maxSolutions) {
      if (options.solutionsAreTarget) {
        fulfilled = true;
        return true;
      }
      return true;
    }
    return options.maxNodes !== undefined && nodesVisited >= options.maxNodes;
  };

  const partial: Record<string, number> = {};
  const visit = (depth: number): void => {
    if (cutShort) return;
    if (depth === problem.vars.length) {
      samples.push({ ...partial });
      if (budgetHit()) cutShort = true;
      return;
    }
    const variable = problem.vars[depth];
    if (variable === undefined) return;
    for (const value of domains[depth] ?? []) {
      if (cutShort) return;
      partial[variable.name] = value;
      nodesVisited++;
      if (consistentPartial(problem, partial)) {
        visit(depth + 1);
      }
      if (budgetHit()) cutShort = true;
    }
    delete partial[variable.name];
  };
  visit(0);

  const status = fulfilled
    ? 'complete'
    : cutShort
      ? 'incomplete'
      : samples.length === 0
        ? 'unsatisfiable'
        : 'complete';
  return { status, samples, nodesVisited };
}

function toSearchOptions(budget: Budget): SearchOptions {
  return {
    ...(budget.maxNodes !== undefined ? { maxNodes: budget.maxNodes } : {}),
    ...(budget.maxSolutions !== undefined ? { maxSolutions: budget.maxSolutions } : {}),
  };
}

/**
 * Exact enumeration of every satisfying assignment, in lexicographic
 * variable/domain order, subject to `budget`.
 *
 * With no budget the result is always `complete` (all solutions) or
 * `unsatisfiable` (proven none exist). A budget that cuts the search short
 * yields `incomplete` — never confused with `unsatisfiable`.
 */
export function enumerateSolutions(problem: Problem, budget: Budget = {}): SolveResult {
  return search(problem, toSearchOptions(budget));
}

export interface SampleOptions extends Budget {
  /** Seed for the deterministic PRNG; same seed => same samples. */
  readonly seed: number;
  /** Number of distinct samples to produce. */
  readonly count: number;
}

/**
 * Seeded random sampling: randomized backtracking with shuffled domains.
 * Produces up to `count` distinct solutions, fully determined by `seed`.
 *
 * Status mirrors {@link enumerateSolutions}: `complete` when `count` samples
 * were found (or the space was exhausted and these are all of them),
 * `unsatisfiable` when the whole space was explored with no solution, and
 * `incomplete` when the budget ran out first.
 */
export function sampleRandom(problem: Problem, options: SampleOptions): SolveResult {
  const rand = createRng(options.seed);
  return search(problem, {
    ...toSearchOptions(options),
    maxSolutions: options.count,
    solutionsAreTarget: true,
    order: (values) => shuffled(values, rand),
  });
}
