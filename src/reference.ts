import type { NodeId } from './graph';

/**
 * Independent, cache-free reference implementation used by the tests to
 * cross-check DirectedGraph. Every query recomputes a full per-source BFS
 * from a plain edge-list snapshot, keeping the lexicographically smallest
 * path among equally short ones by direct path comparison.
 */
export class ReferenceGraph {
  private readonly adj = new Map<NodeId, Set<NodeId>>();

  constructor(edges: Iterable<readonly [NodeId, NodeId]> = []) {
    for (const [from, to] of edges) this.add(from, to);
  }

  add(from: NodeId, to: NodeId): void {
    if (!this.adj.has(from)) this.adj.set(from, new Set());
    if (!this.adj.has(to)) this.adj.set(to, new Set());
    this.adj.get(from)!.add(to);
  }

  remove(from: NodeId, to: NodeId): void {
    this.adj.get(from)?.delete(to);
  }

  nodes(): NodeId[] {
    return [...this.adj.keys()].sort();
  }

  reachable(from: NodeId, to: NodeId): boolean {
    return this.shortestPath(from, to) !== null;
  }

  /** Set of nodes reachable from `from` (including `from` itself). */
  reachableSet(from: NodeId): Set<NodeId> {
    return new Set(this.allShortestPaths(from).keys());
  }

  shortestPath(from: NodeId, to: NodeId): NodeId[] | null {
    return this.allShortestPaths(from).get(to) ?? null;
  }

  /**
   * Layer-by-layer BFS. Within one layer, nodes are expanded in ascending
   * order of their best path, so the first time a node is settled its path
   * is the lexicographically smallest among the shortest ones.
   */
  private allShortestPaths(from: NodeId): Map<NodeId, NodeId[]> {
    const best = new Map<NodeId, NodeId[]>([[from, [from]]]);
    let frontier: NodeId[] = [from];
    while (frontier.length > 0) {
      frontier.sort((a, b) => comparePaths(best.get(a)!, best.get(b)!));
      const next = new Map<NodeId, NodeId[]>();
      for (const cur of frontier) {
        const curPath = best.get(cur)!;
        for (const nb of [...(this.adj.get(cur) ?? [])].sort()) {
          if (best.has(nb)) continue;
          const candidate = [...curPath, nb];
          const prev = next.get(nb);
          if (!prev || comparePaths(candidate, prev) < 0) next.set(nb, candidate);
        }
      }
      for (const [node, path] of next) best.set(node, path);
      frontier = [...next.keys()];
    }
    return best;
  }
}

function comparePaths(a: readonly NodeId[], b: readonly NodeId[]): number {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    if (a[i]! < b[i]!) return -1;
    if (a[i]! > b[i]!) return 1;
  }
  return a.length - b.length;
}
