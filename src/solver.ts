import type { Graph } from "./graph";
import { compareCandidates, type Candidate } from "./compare";
import type { NodeId, PathWitness } from "./types";

export function solve(graph: Graph): PathWitness {
  let best: Candidate | null = null;

  const visited = new Set<NodeId>([graph.start]);
  const path: NodeId[] = [graph.start];
  const remaining = new Set<NodeId>(graph.checkpoints);
  remaining.delete(graph.start);
  let totalCost = 0;
  let maxEdge = Number.NEGATIVE_INFINITY;

  const consider = (): void => {
    const candidate: Candidate = { path: [...path], maxEdgeCost: maxEdge, totalCost };
    if (best === null || compareCandidates(candidate, best) < 0) {
      best = candidate;
    }
  };

  const dfs = (u: NodeId): void => {
    if (u === graph.end) {
      if (remaining.size === 0) consider();
      return;
    }
    if (path.length >= graph.maxNodes) return;
    if (best !== null && maxEdge > best.maxEdgeCost) return;
    for (const edge of graph.adj.get(u) ?? []) {
      if (visited.has(edge.to)) continue;
      visited.add(edge.to);
      path.push(edge.to);
      const wasRemaining = remaining.delete(edge.to);
      const savedTotal = totalCost;
      const savedMax = maxEdge;
      totalCost += edge.cost;
      maxEdge = Math.max(maxEdge, edge.cost);
      dfs(edge.to);
      totalCost = savedTotal;
      maxEdge = savedMax;
      if (wasRemaining) remaining.add(edge.to);
      path.pop();
      visited.delete(edge.to);
    }
  };

  dfs(graph.start);

  if (best === null) {
    return {
      found: false,
      path: [],
      maxEdgeCost: null,
      totalCost: null,
      nodeCount: 0,
      checkpoints: [...graph.checkpoints],
      maxNodes: graph.maxNodes,
    };
  }

  const winner: Candidate = best;
  return {
    found: true,
    path: winner.path,
    maxEdgeCost: winner.maxEdgeCost === Number.NEGATIVE_INFINITY ? null : winner.maxEdgeCost,
    totalCost: winner.totalCost,
    nodeCount: winner.path.length,
    checkpoints: [...graph.checkpoints],
    maxNodes: graph.maxNodes,
  };
}
