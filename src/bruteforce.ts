import type { Problem } from "./types.js";

export const BRUTE_FORCE_MAX_N = 10;

export interface BruteForceResult {
  feasible: boolean;
  cost: number;
  /** Best row->col permutation (lexicographically first among ties). */
  matching: number[];
  permutationsExamined: number;
}

/**
 * Exact cross-check by enumerating all permutations with forbidden-edge
 * pruning. Exponential; intended for small n (<= 10).
 */
export function bruteForce(problem: Problem): BruteForceResult {
  const n = problem.orders.length;
  if (n > BRUTE_FORCE_MAX_N) throw new Error(`brute force limited to n <= ${BRUTE_FORCE_MAX_N}, got ${n}`);
  let best = Infinity;
  let bestPerm: number[] = [];
  let examined = 0;
  const used = new Array<boolean>(n).fill(false);
  const perm = new Array<number>(n).fill(-1);
  // Lower bound for rows i..n-1: sum of each row's minimum allowed cost.
  // Valid (and necessary) even with negative costs, unlike pruning on acc alone.
  const suffixMin = new Array<number>(n + 1).fill(0);
  for (let i = n - 1; i >= 0; i--) {
    let rowMin = 0;
    for (let j = 0; j < n; j++) {
      const c = problem.costs[i]![j]!;
      if (c !== null && c < rowMin) rowMin = c;
    }
    suffixMin[i] = suffixMin[i + 1]! + rowMin;
  }
  const visit = (i: number, acc: number): void => {
    if (acc + suffixMin[i]! >= best) return;
    if (i === n) {
      examined++;
      best = acc;
      bestPerm = [...perm];
      return;
    }
    for (let j = 0; j < n; j++) {
      if (used[j]!) continue;
      const c = problem.costs[i]![j]!;
      if (c === null) continue;
      used[j] = true;
      perm[i] = j;
      visit(i + 1, acc + c);
      used[j] = false;
      perm[i] = -1;
    }
  };
  visit(0, 0);
  return { feasible: bestPerm.length > 0, cost: bestPerm.length > 0 ? best : NaN, matching: bestPerm, permutationsExamined: examined };
}
