import { Problem } from "./model";
import { RankedTeam, compareRanked } from "./compare";

export interface Solution {
  feasible: boolean;
  /** Sorted team member ids (empty when infeasible). */
  team: string[];
  cost: number;
}

/**
 * Exact branch-and-bound solver.
 *
 * Objective: minimize total cost; ties broken by smaller team size, then by
 * lexicographically smaller sorted id list. Costs are >= 0, so the current
 * partial cost is a valid lower bound for any completion. A second pruning
 * rule uses per-skill suffix headcounts to cut branches that can never meet
 * the skill minimums.
 */
export function solve(problem: Problem): Solution {
  const n = problem.ids.length;
  const s = problem.skills.length;

  // Search order: cheaper people first (then id) to find good incumbents early.
  const order = Array.from({ length: n }, (_, i) => i).sort(
    (a, b) => problem.costs[a] - problem.costs[b] || (problem.ids[a] < problem.ids[b] ? -1 : 1),
  );
  const position = new Array<number>(n);
  order.forEach((orig, pos) => {
    position[orig] = pos;
  });

  const costs = order.map((i) => problem.costs[i]);
  const skillMask = order.map((i) => problem.personSkillMask[i]);
  const forbidden = order.map((i) => {
    let mask = 0;
    for (let j = 0; j < n; j++) {
      if ((problem.forbiddenMask[i] >> j) & 1) {
        mask |= 1 << position[j];
      }
    }
    return mask;
  });

  // suffixCounts[k][t] = number of people at search positions k..n-1 with skill t.
  const suffixCounts: Int32Array[] = new Array(n + 1);
  suffixCounts[n] = new Int32Array(s);
  for (let k = n - 1; k >= 0; k--) {
    const row = Int32Array.from(suffixCounts[k + 1]);
    const mask = skillMask[k];
    for (let t = 0; t < s; t++) {
      if ((mask >> t) & 1) row[t]++;
    }
    suffixCounts[k] = row;
  }

  const required = problem.required;
  const counts = new Int32Array(s);
  let unmet = 0;
  for (let t = 0; t < s; t++) {
    if (required[t] > 0) unmet++;
  }

  let best: RankedTeam | null = null;
  let currentCost = 0;
  let chosenMask = 0;
  const chosen: number[] = [];

  const considerCandidate = (): void => {
    const ids = chosen.map((pos) => problem.ids[order[pos]]).sort();
    const candidate: RankedTeam = { cost: currentCost, size: chosen.length, ids };
    if (best === null || compareRanked(candidate, best) < 0) {
      best = candidate;
    }
  };

  const recurse = (k: number): void => {
    if (unmet === 0) {
      considerCandidate();
    }
    if (best !== null) {
      // Costs are non-negative, so any extension keeps cost >= currentCost and
      // strictly increases size; once we tie the incumbent on cost and match
      // or exceed its size, no extension can win.
      if (currentCost > best.cost) return;
      if (currentCost === best.cost && chosen.length >= best.size) return;
    }
    if (k === n) return;
    const remaining = suffixCounts[k];
    for (let t = 0; t < s; t++) {
      if (counts[t] + remaining[t] < required[t]) return;
    }

    // Branch 1: include person at position k (if no forbidden conflict).
    if ((forbidden[k] & chosenMask) === 0) {
      const mask = skillMask[k];
      chosenMask |= 1 << k;
      chosen.push(k);
      currentCost += costs[k];
      for (let t = 0; t < s; t++) {
        if ((mask >> t) & 1) {
          counts[t]++;
          if (counts[t] === required[t]) unmet--;
        }
      }
      recurse(k + 1);
      for (let t = 0; t < s; t++) {
        if ((mask >> t) & 1) {
          if (counts[t] === required[t]) unmet++;
          counts[t]--;
        }
      }
      currentCost -= costs[k];
      chosen.pop();
      chosenMask &= ~(1 << k);
    }

    // Branch 2: exclude person at position k.
    recurse(k + 1);
  };

  recurse(0);

  if (best === null) {
    return { feasible: false, team: [], cost: 0 };
  }
  const solved: RankedTeam = best;
  return { feasible: true, team: solved.ids, cost: solved.cost };
}
