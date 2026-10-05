import type { Graph } from "../src/graph";
import type { NodeId } from "../src/types";
import { compareCandidates, type Candidate } from "../src/compare";

interface Frame {
  node: NodeId;
  path: NodeId[];
  visited: Set<NodeId>;
  remaining: Set<NodeId>;
  total: number;
  max: number;
}

export function enumerateFeasiblePaths(graph: Graph): Candidate[] {
  const out: Candidate[] = [];
  const remaining0 = new Set<NodeId>(graph.checkpoints);
  remaining0.delete(graph.start);
  const stack: Frame[] = [
    {
      node: graph.start,
      path: [graph.start],
      visited: new Set([graph.start]),
      remaining: remaining0,
      total: 0,
      max: Number.NEGATIVE_INFINITY,
    },
  ];
  while (stack.length > 0) {
    const frame = stack.pop()!;
    if (frame.node === graph.end) {
      if (frame.remaining.size === 0) {
        out.push({ path: frame.path, maxEdgeCost: frame.max, totalCost: frame.total });
      }
      continue;
    }
    if (frame.path.length >= graph.maxNodes) continue;
    for (const edge of graph.adj.get(frame.node) ?? []) {
      if (frame.visited.has(edge.to)) continue;
      const visited = new Set(frame.visited);
      visited.add(edge.to);
      const remaining = new Set(frame.remaining);
      remaining.delete(edge.to);
      stack.push({
        node: edge.to,
        path: [...frame.path, edge.to],
        visited,
        remaining,
        total: frame.total + edge.cost,
        max: Math.max(frame.max, edge.cost),
      });
    }
  }
  return out;
}

export function bruteForceBest(graph: Graph): Candidate | null {
  let best: Candidate | null = null;
  for (const candidate of enumerateFeasiblePaths(graph)) {
    if (best === null || compareCandidates(candidate, best) < 0) {
      best = candidate;
    }
  }
  return best;
}
