/**
 * Verification by explicit enumeration of leaf allocation vectors.
 *
 * Enumerates every vector within leaf bounds and the total budget in
 * lexicographically ascending order, filters by all node aggregate bounds
 * and cross constraints, and keeps the best payoff (first, i.e.
 * lexicographically smallest, among ties). Used in tests to cross-check the
 * tree DP and the constrained branch-and-bound.
 */

import { Problem, evaluateVector, normalize } from './model';
import { TreeSolution } from './treeDp';

export function bruteForceSolve(problem: Problem): TreeSolution {
  const norm = normalize(problem);
  const n = norm.leaves.length;
  const vector = new Array<number>(n).fill(0);
  let bestPayoff = -Infinity;
  let bestVector: number[] | null = null;

  const recurse = (i: number, remaining: number): void => {
    if (i === n) {
      const evaluation = evaluateVector(norm, vector);
      if (!evaluation.feasible) return;
      // Enumeration is lexicographic, so a strict improvement keeps the
      // lexicographically smallest vector among all optima.
      if (evaluation.payoff > bestPayoff) {
        bestPayoff = evaluation.payoff;
        bestVector = vector.slice();
      }
      return;
    }
    const leaf = norm.leaves[i];
    const hi = Math.min(leaf.max, leaf.gain.length - 1, remaining);
    for (let x = leaf.min; x <= hi; x++) {
      vector[i] = x;
      recurse(i + 1, remaining - x);
    }
  };
  recurse(0, norm.budget);

  if (bestVector === null) {
    return { feasible: false, payoff: null, vector: null, aggregates: null };
  }
  const evaluation = evaluateVector(norm, bestVector);
  return {
    feasible: true,
    payoff: bestPayoff,
    vector: bestVector,
    aggregates: evaluation.aggregates,
  };
}
