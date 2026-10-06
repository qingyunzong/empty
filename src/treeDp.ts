/**
 * Exact tree DP for the problem WITHOUT cross constraints.
 *
 * Objective: maximize total gain; ties are broken by the lexicographically
 * smallest leaf allocation vector (leaves in document order).
 *
 * For every node v and every feasible aggregate s we keep the best
 * (value, vector) pair for the subtree of v. Lexicographic tie-breaking is
 * compatible with the DP because child subtrees form contiguous, ordered
 * blocks of the leaf vector: comparing concatenations lexicographically
 * reduces to comparing the child vectors in order.
 */

import { NormalizedNode, NormalizedProblem, Problem, computeAggregates, normalize } from './model';

export interface TreeSolution {
  feasible: boolean;
  /** null when infeasible */
  payoff: number | null;
  /** Leaf allocation vector in document order; null when infeasible. */
  vector: number[] | null;
  /** Aggregate sum of every node, keyed by node id; null when infeasible. */
  aggregates: Record<string, number> | null;
}

interface DpEntry {
  value: number;
  vector: number[];
}

export function lexCompare(a: number[], b: number[]): number {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    if (a[i] !== b[i]) return a[i] < b[i] ? -1 : 1;
  }
  return a.length - b.length;
}

function better(candidate: DpEntry, current: DpEntry | null): boolean {
  if (current === null) return true;
  if (candidate.value !== current.value) return candidate.value > current.value;
  return lexCompare(candidate.vector, current.vector) < 0;
}

function solveNode(node: NormalizedNode, norm: NormalizedProblem): (DpEntry | null)[] {
  const budget = norm.budget;
  const dp: (DpEntry | null)[] = new Array(budget + 1).fill(null);

  if (node.leafIndex !== null) {
    const leaf = norm.leaves[node.leafIndex];
    const hi = Math.min(leaf.max, leaf.gain.length - 1, budget);
    for (let x = leaf.min; x <= hi; x++) {
      dp[x] = { value: leaf.gain[x], vector: [x] };
    }
    return dp;
  }

  let acc: (DpEntry | null)[] = new Array(budget + 1).fill(null);
  acc[0] = { value: 0, vector: [] };
  for (const child of node.children) {
    const childDp = solveNode(child, norm);
    const next: (DpEntry | null)[] = new Array(budget + 1).fill(null);
    for (let s1 = 0; s1 <= budget; s1++) {
      const e1 = acc[s1];
      if (e1 === null) continue;
      for (let s2 = 0; s1 + s2 <= budget; s2++) {
        const e2 = childDp[s2];
        if (e2 === null) continue;
        const candidate: DpEntry = {
          value: e1.value + e2.value,
          vector: e1.vector.concat(e2.vector),
        };
        if (better(candidate, next[s1 + s2])) next[s1 + s2] = candidate;
      }
    }
    acc = next;
  }

  for (let s = 0; s <= budget; s++) {
    if (s < node.min || s > node.max) acc[s] = null;
  }
  return acc;
}

export function solveNormalized(norm: NormalizedProblem): TreeSolution {
  const rootDp = solveNode(norm.root, norm);
  let best: DpEntry | null = null;
  for (let s = 0; s <= norm.budget; s++) {
    const entry = rootDp[s];
    if (entry !== null && better(entry, best)) best = entry;
  }
  if (best === null) {
    return { feasible: false, payoff: null, vector: null, aggregates: null };
  }
  return {
    feasible: true,
    payoff: best.value,
    vector: best.vector,
    aggregates: computeAggregates(norm.root, best.vector),
  };
}

/**
 * Solve a problem without cross constraints exactly.
 * Throws if the problem declares cross constraints — use ConstrainedSolver
 * for those; independent subtree DP is not valid across coupled subtrees.
 */
export function solveTreeDp(problem: Problem): TreeSolution {
  const norm = normalize(problem);
  if (norm.constraints.length > 0) {
    throw new Error(
      'solveTreeDp does not support cross constraints; use ConstrainedSolver instead',
    );
  }
  return solveNormalized(norm);
}
