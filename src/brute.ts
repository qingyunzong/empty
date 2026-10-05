import { Problem } from "./model";
import { RankedTeam, compareRanked } from "./compare";
import { Solution } from "./solve";

export const BRUTE_FORCE_MAX_PEOPLE = 26;

/**
 * Exhaustive enumeration of all 2^n teams. Used to cross-check the
 * branch-and-bound solver on small instances.
 */
export function solveBruteForce(problem: Problem): Solution {
  const n = problem.ids.length;
  if (n > BRUTE_FORCE_MAX_PEOPLE) {
    throw new Error(`brute force supports at most ${BRUTE_FORCE_MAX_PEOPLE} people (got ${n})`);
  }
  const s = problem.skills.length;
  const counts = new Int32Array(s);
  let best: RankedTeam | null = null;
  const total = 1 << n;

  for (let mask = 0; mask < total; mask++) {
    let conflict = false;
    for (let i = 0; i < n; i++) {
      if (((mask >> i) & 1) !== 0 && (problem.forbiddenMask[i] & mask) !== 0) {
        conflict = true;
        break;
      }
    }
    if (conflict) continue;

    let cost = 0;
    counts.fill(0);
    for (let i = 0; i < n; i++) {
      if (((mask >> i) & 1) === 0) continue;
      cost += problem.costs[i];
      const sm = problem.personSkillMask[i];
      for (let t = 0; t < s; t++) {
        if ((sm >> t) & 1) counts[t]++;
      }
    }
    let feasible = true;
    for (let t = 0; t < s; t++) {
      if (counts[t] < problem.required[t]) {
        feasible = false;
        break;
      }
    }
    if (!feasible) continue;

    const ids: string[] = [];
    for (let i = 0; i < n; i++) {
      if ((mask >> i) & 1) ids.push(problem.ids[i]);
    }
    ids.sort();
    const candidate: RankedTeam = { cost, size: ids.length, ids };
    if (best === null || compareRanked(candidate, best) < 0) {
      best = candidate;
    }
  }

  if (best === null) {
    return { feasible: false, team: [], cost: 0 };
  }
  const solved: RankedTeam = best;
  return { feasible: true, team: solved.ids, cost: solved.cost };
}
