/**
 * Cache-free reference implementation used to cross-check DirectedGraph.
 * Every query recomputes from scratch, one source at a time.
 */

export type EdgeList = ReadonlyArray<readonly [string, string]>;

function buildAdj(nodes: readonly string[], edges: EdgeList): Map<string, string[]> {
  const adj = new Map<string, string[]>();
  for (const n of nodes) adj.set(n, []);
  for (const [u, v] of edges) {
    if (!adj.has(u)) adj.set(u, []);
    if (!adj.has(v)) adj.set(v, []);
    adj.get(u)!.push(v);
  }
  return adj;
}

/** Per-source BFS: set of nodes reachable from `src` (including `src`). */
export function refReachable(nodes: readonly string[], edges: EdgeList, src: string): Set<string> {
  const adj = buildAdj(nodes, edges);
  const seen = new Set<string>([src]);
  const queue = [src];
  for (let head = 0; head < queue.length; head++) {
    for (const nxt of adj.get(queue[head]!) ?? []) {
      if (!seen.has(nxt)) {
        seen.add(nxt);
        queue.push(nxt);
      }
    }
  }
  return seen;
}

/**
 * Reference shortest path: brute-force enumeration of all simple paths
 * from `src` to `dst`, keeping the minimum length and, among those, the
 * lexicographically smallest node sequence. Exponential, but exact —
 * intended for small test graphs.
 */
export function refShortestPath(
  nodes: readonly string[],
  edges: EdgeList,
  src: string,
  dst: string,
): string[] | null {
  const adj = buildAdj(nodes, edges);
  let best: string[] | null = null;

  const consider = (candidate: string[]): void => {
    if (best === null) {
      best = candidate;
      return;
    }
    if (candidate.length < best.length) {
      best = candidate;
      return;
    }
    if (candidate.length === best.length) {
      for (let i = 0; i < candidate.length; i++) {
        const a = candidate[i]!;
        const b = best[i]!;
        if (a !== b) {
          if (a < b) best = candidate;
          return;
        }
      }
    }
  };

  const dfs = (cur: string, path: string[], visited: Set<string>): void => {
    if (cur === dst) {
      consider([...path]);
      return;
    }
    if (best !== null && path.length >= best.length) return; // cannot improve
    for (const nxt of adj.get(cur) ?? []) {
      if (visited.has(nxt)) continue;
      visited.add(nxt);
      path.push(nxt);
      dfs(nxt, path, visited);
      path.pop();
      visited.delete(nxt);
    }
  };

  dfs(src, [src], new Set([src]));
  return best;
}
