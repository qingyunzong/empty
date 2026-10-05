import { compareSubsets, toMasked, type Problem } from "./model.js";

export interface BruteForceResult {
  feasible: boolean;
  cost: number | null;
  indices: number[]; // selected candidate indices (empty when infeasible)
  subsetsEvaluated: number;
}

// Exhaustively enumerates all 2^n subsets. Used as the ground-truth check for
// the branch-and-bound solver and directly usable for small candidate sets.
export function solveBruteForce(problem: Problem): BruteForceResult {
  const mp = toMasked(problem);
  const n = problem.candidates.length;
  const total = 2 ** n;
  let bestCost: number | null = null;
  let bestIds: string[] = [];
  let bestMask = 0;
  for (let mask = 0; mask < total; mask++) {
    let allow = 0n;
    let deny = 0n;
    let cost = 0;
    const ids: string[] = [];
    for (let i = 0; i < n; i++) {
      if ((mask & (1 << i)) !== 0) {
        allow |= mp.allowMask[i]!;
        deny |= mp.denyMask[i]!;
        cost += mp.costs[i]!;
        ids.push(mp.ids[i]!);
      }
    }
    // A sample is decided "allow" iff some selected allow-rule matches it and
    // no selected deny-rule does (deny priority); everything else is deny.
    if ((allow & ~deny) !== mp.expectAllowMask) continue;
    ids.sort();
    if (bestCost === null || compareSubsets({ cost, ids }, { cost: bestCost, ids: bestIds }) < 0) {
      bestCost = cost;
      bestIds = ids;
      bestMask = mask;
    }
  }
  const indices: number[] = [];
  if (bestCost !== null) {
    for (let i = 0; i < n; i++) {
      if ((bestMask & (1 << i)) !== 0) indices.push(i);
    }
  }
  return { feasible: bestCost !== null, cost: bestCost, indices, subsetsEvaluated: total };
}
