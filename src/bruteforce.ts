import { validateLayout, type Layout, type Placement, type Problem } from './model.js';
import { generateCandidates } from './solver.js';

export interface BruteForceResult {
  feasible: boolean;
  objective: number | null;
  layout: Layout | null;
  /** Number of complete valid layouts examined. */
  validLayouts: number;
}

/**
 * Exhaustive enumeration of every valid layout (intended for tiny grids only).
 * Every complete assignment is re-checked with validateLayout, so this is a
 * fully independent oracle for cross-checking the branch & bound solver.
 */
export function bruteForce(problem: Problem): BruteForceResult {
  const n = problem.rects.length;
  const candidates = problem.rects.map((_, i) => generateCandidates(problem, i));
  const assignment: (Placement | null)[] = new Array<Placement | null>(n).fill(null);

  let best = Infinity;
  let bestLayout: Layout | null = null;
  let validLayouts = 0;

  const dfs = (depth: number, cost: number): void => {
    if (depth === n) {
      const layout: Layout = {};
      for (let i = 0; i < n; i++) layout[problem.rects[i]!.id] = assignment[i]!;
      if (validateLayout(problem, layout).length > 0) return;
      validLayouts++;
      if (cost < best) {
        best = cost;
        bestLayout = layout;
      }
      return;
    }
    const old = problem.oldLayout[problem.rects[depth]!.id]!;
    for (const cand of candidates[depth]!) {
      let ok = true;
      for (let i = 0; i < depth && ok; i++) {
        const p = assignment[i]!;
        if (cand.x < p.x + p.w && p.x < cand.x + cand.w && cand.y < p.y + p.h && p.y < cand.y + cand.h) {
          ok = false;
        }
      }
      if (!ok) continue;
      assignment[depth] = cand;
      dfs(depth + 1, cost + Math.abs(cand.x - old.x) + Math.abs(cand.y - old.y));
      assignment[depth] = null;
    }
  };

  dfs(0, 0);
  return bestLayout === null
    ? { feasible: false, objective: null, layout: null, validLayouts }
    : { feasible: true, objective: best, layout: bestLayout, validLayouts };
}
