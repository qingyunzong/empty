import { buildSolution, deletableIndices } from './cert.js';
import { findCycle, reachable } from './graph.js';
import { impossibleGroups } from './parse.js';
import { branchAndBound, bruteForce } from './solver.js';
import type { Problem, Solution } from './types.js';

export interface SolveOptions {
  /** cross-check the branch-and-bound optimum with exhaustive enumeration */
  verify?: boolean;
}

export function solveProblem(problem: Problem, opts: SolveOptions = {}): Solution {
  const impossible = impossibleGroups(problem);
  const forcedKeep = (i: number): boolean => {
    const e = problem.edges[i]!;
    return e.locked || (e.group !== null && impossible.has(e.group));
  };

  // 1. undeletable cycle?
  const lockedCycle = findCycle(problem.nodes, problem.edges, forcedKeep);
  if (lockedCycle !== null) {
    return { status: 'infeasible', infeasible: { reason: 'locked-cycle', cycle: lockedCycle } };
  }

  // 2. required pairs must be reachable in the full graph (deleting edges never adds reachability)
  for (const p of problem.pairs) {
    if (!reachable(p.from, p.to, problem.edges, () => true)) {
      return {
        status: 'infeasible',
        infeasible: { reason: `required pair ${p.from} -> ${p.to} is unreachable even with all edges kept` },
      };
    }
  }

  // 3. branch and bound
  const bb = branchAndBound(problem);
  if (bb.mask === null) {
    // distinguish "budget too small" from structural infeasibility
    const relaxed = branchAndBound({ ...problem, budget: Infinity });
    if (relaxed.mask !== null) {
      return {
        status: 'infeasible',
        infeasible: {
          reason: `budget ${problem.budget} too small for minimum feasible cost ${relaxed.cost}`,
          minCostWithoutBudget: relaxed.cost ?? undefined,
        },
      };
    }
    return {
      status: 'infeasible',
      infeasible: { reason: 'no deletion set satisfies acyclicity, reachability and group prerequisites' },
    };
  }

  const sol = buildSolution(problem, bb.mask, deletableIndices(problem), bb.stats);
  if (opts.verify) {
    const bf = bruteForce(problem);
    sol.proof!.enumeration = {
      subsetsChecked: 1 << bf.stats.deletableEdges,
      bestCost: bf.cost,
      matches: bf.cost === sol.totalCost,
    };
  }
  return sol;
}
