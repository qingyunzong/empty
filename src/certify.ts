import { findCycle, shortestPath, topoOrder } from "./graph";
import { enumerateAll, groupClosure, maskCost, SolveResult } from "./solver";
import { NormalizedProblem } from "./types";

export interface DeletedEdgeProof {
  id: string;
  from: string;
  to: string;
  cost: number;
  reason: string;
  /** cycle in the original graph on which this is the unique deleted edge */
  witnessCycle?: string[];
  /** group-prerequisite chain forcing this deletion */
  forcedBy?: { edge: string; chain: string[] };
}

export interface PathCertificate {
  from: string;
  to: string;
  nodes: string[];
  edges: string[];
}

export interface Report {
  status: "optimal" | "infeasible";
  cost?: number;
  budget: number | null;
  deletedEdges?: DeletedEdgeProof[];
  topologicalOrder?: string[];
  reachabilityCertificates?: PathCertificate[];
  optimalityProof?: {
    edgeCount: number;
    enumeration: { subsetsChecked: number; bestCost: number | null };
    branchAndBound: { nodesExplored: number; bestCost: number | null };
    methodsAgree: boolean;
  };
  infeasibility?: {
    kind: string;
    detail: string;
    undeletableCycle?: string[];
    minCostWithoutBudget?: number;
  };
}

function deletedEdgeProofs(p: NormalizedProblem, mask: number): DeletedEdgeProof[] {
  const keep = (i: number) => (mask & (1 << i)) === 0;
  const proofs: DeletedEdgeProof[] = [];
  const forcedQueue: { edge: number; chain: string[] }[] = [];
  for (let i = 0; i < p.edges.length; i++) {
    if (!(mask & (1 << i))) continue;
    const e = p.edges[i]!;
    // a cycle in the original graph where e is the ONLY deleted edge:
    // e plus a surviving path from e.to back to e.from
    const back = shortestPath(p, keep, e.to, e.from);
    if (back) {
      proofs.push({
        id: e.id,
        from: e.from,
        to: e.to,
        cost: e.cost,
        reason: "breaks-cycle",
        witnessCycle: [e.from, ...back.nodes],
      });
      if (e.group) forcedQueue.push({ edge: i, chain: [e.group] });
    } else {
      proofs.push({ id: e.id, from: e.from, to: e.to, cost: e.cost, reason: "" });
    }
  }
  // attribute remaining deletions to group prerequisites, BFS over group graph
  const explained = new Set<number>();
  proofs.forEach((pr, i) => {
    if (pr.reason === "breaks-cycle") explained.add(i);
  });
  const deletedIdx: number[] = [];
  for (let i = 0; i < p.edges.length; i++) if (mask & (1 << i)) deletedIdx.push(i);
  const groupOf = (idx: number) => p.edges[idx]!.group;
  const visitedGroup = new Map<string, { edge: number; chain: string[] }>();
  const queue = [...forcedQueue];
  for (const q of queue) visitedGroup.set(groupOf(q.edge), q);
  while (queue.length) {
    const cur = queue.shift()!;
    const g = groupOf(cur.edge);
    for (const req of p.groupRequires.get(g) ?? []) {
      if (!visitedGroup.has(req)) {
        const next = { edge: cur.edge, chain: [...cur.chain, req] };
        visitedGroup.set(req, next);
        // pick any deleted edge of that group as representative for further expansion
        const rep = deletedIdx.find((j) => groupOf(j) === req);
        if (rep !== undefined) queue.push({ edge: rep, chain: next.chain });
      }
    }
  }
  deletedIdx.forEach((idx, k) => {
    const pr = proofs[k]!;
    if (pr.reason) return;
    const g = groupOf(idx);
    const via = g ? visitedGroup.get(g) : undefined;
    if (via && g && groupOf(via.edge) !== g) {
      pr.reason = "group-prerequisite";
      pr.forcedBy = { edge: p.edges[via.edge]!.id, chain: via.chain };
    } else if (via && g && groupOf(via.edge) === g && p.edges[via.edge]!.id !== pr.id) {
      pr.reason = "group-prerequisite";
      pr.forcedBy = { edge: p.edges[via.edge]!.id, chain: via.chain };
    } else {
      pr.reason = pr.cost === 0 ? "redundant-zero-cost" : "unjustified";
    }
  });
  return proofs;
}

function diagnoseInfeasible(p: NormalizedProblem, result: SolveResult): Report["infeasibility"] {
  // 1. cycle made purely of locked edges
  const lockedCycle = findCycle(p, (i) => p.edges[i]!.locked);
  if (lockedCycle) {
    return {
      kind: "locked-cycle",
      detail: "a cycle consists entirely of locked (undeletable) edges",
      undeletableCycle: lockedCycle,
    };
  }
  // 2. reachability impossible even with zero deletions
  for (const r of p.reachability) {
    const path = shortestPath(p, () => true, r.from, r.to);
    if (!path) {
      return { kind: "reachability", detail: `no path ${r.from} -> ${r.to} exists in the original graph` };
    }
  }
  // 3. group closure conflicts: some group deletion forces a locked edge
  for (const [group, members] of p.groupEdges) {
    const probe = 1 << members[0]!;
    if (groupClosure(p, probe) === null) {
      return {
        kind: "group-locked-conflict",
        detail: `deleting any edge of group ${group} forces deletion of a locked edge`,
      };
    }
  }
  // 4. budget: recompute optimum ignoring the budget
  const saved = p.budget;
  (p as { budget: number }).budget = Infinity;
  const en = enumerateAll(p);
  (p as { budget: number }).budget = saved;
  if (en.bestMask !== -1) {
    return {
      kind: "budget",
      detail: `minimum feasible cost ${en.bestCost} exceeds budget ${saved}`,
      minCostWithoutBudget: en.bestCost,
    };
  }
  return { kind: "unknown", detail: "no feasible deletion set exists" };
}

export function buildReport(p: NormalizedProblem, result: SolveResult): Report {
  const budget = p.budget === Infinity ? null : p.budget;
  const optimalityProof = {
    edgeCount: p.edges.length,
    enumeration: result.enumeration,
    branchAndBound: result.branchAndBound,
    methodsAgree: result.agree,
  };
  if (!result.feasible) {
    return { status: "infeasible", budget, optimalityProof, infeasibility: diagnoseInfeasible(p, result) };
  }
  const mask = result.bestMask;
  const keep = (i: number) => (mask & (1 << i)) === 0;
  const order = topoOrder(p, keep)!;
  const certs: PathCertificate[] = p.reachability.map((r) => {
    const path = shortestPath(p, keep, r.from, r.to)!;
    return { from: r.from, to: r.to, nodes: path.nodes, edges: path.edges.map((i) => p.edges[i]!.id) };
  });
  return {
    status: "optimal",
    cost: maskCost(p, mask),
    budget,
    deletedEdges: deletedEdgeProofs(p, mask),
    topologicalOrder: order,
    reachabilityCertificates: certs,
    optimalityProof,
  };
}
