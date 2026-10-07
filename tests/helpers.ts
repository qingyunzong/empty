import type { Graph } from '../src/graph.ts';

export function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Random directed graph where every node is reachable from node 0
 * (a random outgoing spanning tree plus extra random edges).
 */
export function randomGraph(
  rng: () => number,
  nodeCount: number,
  extraEdges: number,
  minCost: number,
  maxCost: number,
): Graph {
  const nodes = Array.from({ length: nodeCount }, (_, i) => `n${i}`);
  const edges: Graph['edges'] = [];
  let nextId = 0;
  const addEdge = (from: string, to: string) => {
    const cost = minCost + Math.floor(rng() * (maxCost - minCost + 1));
    edges.push({ id: `e${nextId++}`, from, to, cost, version: 1 + Math.floor(rng() * 5) });
  };
  for (let i = 1; i < nodeCount; i++) {
    addEdge(nodes[Math.floor(rng() * i)], nodes[i]);
  }
  for (let i = 0; i < extraEdges; i++) {
    const from = nodes[Math.floor(rng() * nodeCount)];
    const to = nodes[Math.floor(rng() * nodeCount)];
    if (from !== to) {
      addEdge(from, to);
    }
  }
  return { nodes, edges };
}

export interface SimplePath {
  edgeIds: string[];
  cost: number;
}

/** Reference: enumerate all simple paths from source to target (small graphs only). */
export function allSimplePaths(graph: Graph, source: string, target: string): SimplePath[] {
  const out = new Map<string, { to: string; cost: number; id: string }[]>();
  for (const edge of graph.edges) {
    const list = out.get(edge.from) ?? [];
    list.push(edge);
    out.set(edge.from, list);
  }
  const results: SimplePath[] = [];
  const visit = (node: string, seen: Set<string>, edgeIds: string[], cost: number) => {
    if (node === target) {
      results.push({ edgeIds: [...edgeIds], cost });
      return;
    }
    for (const edge of out.get(node) ?? []) {
      if (!seen.has(edge.to)) {
        seen.add(edge.to);
        edgeIds.push(edge.id);
        visit(edge.to, seen, edgeIds, cost + edge.cost);
        edgeIds.pop();
        seen.delete(edge.to);
      }
    }
  };
  visit(source, new Set([source]), [], 0);
  return results;
}

export function minSimplePathCost(graph: Graph, source: string, target: string): number {
  const paths = allSimplePaths(graph, source, target);
  return paths.reduce((best, path) => Math.min(best, path.cost), Infinity);
}
