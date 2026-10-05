import { findCycle, shortestPath, topoSort } from './graph.js';
import { impossibleGroups } from './parse.js';
import { bruteForce } from './solver.js';
import type { DeletedEdgeInfo, PathCertificate, Problem, Solution, SolveStats } from './types.js';

/** Build the full solution object (topological order + path certificates) for a deletion mask. */
export function buildSolution(
  problem: Problem,
  mask: number,
  deletable: number[],
  stats: SolveStats,
): Solution {
  const deleted = new Set<number>();
  for (let b = 0; b < deletable.length; b++) {
    if (mask & (1 << b)) deleted.add(deletable[b]!);
  }
  const remaining = problem.edges.filter((_, i) => !deleted.has(i));
  const keep = (i: number) => !deleted.has(i);

  const deletedEdges: DeletedEdgeInfo[] = [...deleted]
    .map((i) => problem.edges[i]!)
    .sort((a, b) => a.id.localeCompare(b.id))
    .map((e) => ({ id: e.id, from: e.from, to: e.to, cost: e.cost, group: e.group }));
  const totalCost = deletedEdges.reduce((s, e) => s + e.cost, 0);

  const topologicalOrder = topoSort(problem.nodes, remaining);
  if (topologicalOrder === null) throw new Error('internal: remaining graph is cyclic');

  const preservedPaths: PathCertificate[] = problem.pairs.map((p) => {
    const path = shortestPath(p.from, p.to, problem.edges, keep);
    if (path === null) throw new Error(`internal: pair ${p.from} -> ${p.to} not preserved`);
    return { from: p.from, to: p.to, path };
  });

  return {
    status: 'optimal',
    deletedEdges,
    totalCost,
    topologicalOrder,
    preservedPaths,
    proof: { method: 'branch-and-bound', stats },
  };
}

export function deletableIndices(problem: Problem): number[] {
  const impossible = impossibleGroups(problem);
  const out: number[] = [];
  problem.edges.forEach((e, i) => {
    const fixed = e.locked || (e.group !== null && impossible.has(e.group));
    if (!fixed) out.push(i);
  });
  out.sort((a, b) => problem.edges[a]!.id.localeCompare(problem.edges[b]!.id));
  return out;
}

export interface CheckResult {
  valid: boolean;
  errors: string[];
}

/**
 * Independently validate a solution object against the problem.
 * Re-runs exhaustive enumeration to confirm claimed optimality / infeasibility.
 */
export function checkSolution(problem: Problem, sol: Solution): CheckResult {
  const errors: string[] = [];
  const bf = bruteForce(problem);

  if (sol.status === 'infeasible') {
    if (bf.mask !== null) {
      errors.push(`claimed infeasible but a feasible deletion set exists with cost ${bf.cost}`);
    }
    if (sol.infeasible?.reason === 'locked-cycle') {
      const cyc = sol.infeasible.cycle;
      if (!cyc || cyc.length < 2 || cyc[0] !== cyc[cyc.length - 1]) {
        errors.push('locked-cycle witness is not a closed node list');
      } else {
        for (let k = 0; k + 1 < cyc.length; k++) {
          const ok = problem.edges.some((e) => e.locked && e.from === cyc[k] && e.to === cyc[k + 1]);
          if (!ok) {
            errors.push(`locked-cycle witness uses non-locked or missing edge ${cyc[k]} -> ${cyc[k + 1]}`);
            break;
          }
        }
      }
    }
    return { valid: errors.length === 0, errors };
  }

  if (sol.status !== 'optimal') {
    return { valid: false, errors: [`unknown status "${String(sol.status)}"`] };
  }

  const deletedIds = new Set<string>();
  let totalCost = 0;
  for (const d of sol.deletedEdges ?? []) {
    if (deletedIds.has(d.id)) errors.push(`duplicate deleted edge "${d.id}"`);
    deletedIds.add(d.id);
    const e = problem.edges.find((x) => x.id === d.id);
    if (!e) {
      errors.push(`deleted edge "${d.id}" does not exist`);
      continue;
    }
    if (e.locked) errors.push(`deleted edge "${d.id}" is locked`);
    if (e.from !== d.from || e.to !== d.to) errors.push(`deleted edge "${d.id}" endpoints mismatch`);
    if (e.cost !== d.cost) errors.push(`deleted edge "${d.id}" cost mismatch`);
    totalCost += e.cost;
  }
  if (sol.totalCost !== totalCost) {
    errors.push(`totalCost mismatch: claimed ${sol.totalCost}, actual ${totalCost}`);
  }
  if (totalCost > problem.budget) {
    errors.push(`budget exceeded: ${totalCost} > ${problem.budget}`);
  }

  // group prerequisites
  const groupEdges = new Map<string, string[]>();
  for (const e of problem.edges) {
    if (e.group === null) continue;
    if (!groupEdges.has(e.group)) groupEdges.set(e.group, []);
    groupEdges.get(e.group)!.push(e.id);
  }
  for (const e of problem.edges) {
    if (!deletedIds.has(e.id) || e.group === null) continue;
    for (const req of problem.groupRequires.get(e.group) ?? []) {
      for (const id of groupEdges.get(req) ?? []) {
        if (!deletedIds.has(id)) {
          errors.push(`group prerequisite violated: deleting "${e.id}" (group "${e.group}") requires deleting "${id}" (group "${req}")`);
        }
      }
    }
  }

  // remaining graph must be acyclic and the claimed topological order must be valid
  const remaining = problem.edges.filter((e) => !deletedIds.has(e.id));
  if (findCycle(problem.nodes, remaining, () => true) !== null) {
    errors.push('remaining graph contains a cycle');
  }
  const order = sol.topologicalOrder ?? [];
  const pos = new Map<string, number>();
  order.forEach((n, i) => pos.set(n, i));
  if (order.length !== problem.nodes.length || pos.size !== problem.nodes.length) {
    errors.push('topologicalOrder is not a permutation of all nodes');
  } else {
    for (const e of remaining) {
      if (pos.get(e.from)! >= pos.get(e.to)!) {
        errors.push(`topologicalOrder violates remaining edge ${e.id} (${e.from} -> ${e.to})`);
      }
    }
  }

  // every required pair must be covered by a valid path certificate
  const edgeSet = new Set(remaining.map((e) => `${e.from} -> ${e.to}`));
  const certByPair = new Map<string, string[]>();
  for (const c of sol.preservedPaths ?? []) certByPair.set(`${c.from} -> ${c.to}`, c.path);
  for (const p of problem.pairs) {
    const path = certByPair.get(`${p.from} -> ${p.to}`);
    if (!path) {
      errors.push(`missing path certificate for required pair ${p.from} -> ${p.to}`);
      continue;
    }
    if (path[0] !== p.from || path[path.length - 1] !== p.to) {
      errors.push(`path certificate for ${p.from} -> ${p.to} has wrong endpoints`);
      continue;
    }
    for (let k = 0; k + 1 < path.length; k++) {
      if (!edgeSet.has(`${path[k]} -> ${path[k + 1]}`)) {
        errors.push(`path certificate for ${p.from} -> ${p.to} uses deleted/missing edge ${path[k]} -> ${path[k + 1]}`);
        break;
      }
    }
  }

  // optimality: independently re-enumerate all subsets
  if (bf.mask === null) {
    errors.push('claimed optimal but no feasible deletion set exists');
  } else if (sol.totalCost !== bf.cost) {
    errors.push(`not optimal: claimed cost ${sol.totalCost}, exhaustive enumeration found ${bf.cost}`);
  }

  return { valid: errors.length === 0, errors };
}
