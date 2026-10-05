import type { Edge } from './types.js';

/** Kahn's algorithm; deterministic (lexicographic). Returns null if cyclic. */
export function topoSort(nodes: string[], edges: Edge[]): string[] | null {
  const indeg = new Map<string, number>();
  const adj = new Map<string, string[]>();
  for (const n of nodes) {
    indeg.set(n, 0);
    adj.set(n, []);
  }
  for (const e of edges) {
    indeg.set(e.to, (indeg.get(e.to) ?? 0) + 1);
    adj.get(e.from)!.push(e.to);
  }
  const ready: string[] = [];
  for (const [n, d] of indeg) if (d === 0) ready.push(n);
  ready.sort();
  const order: string[] = [];
  while (ready.length > 0) {
    const n = ready.shift()!;
    order.push(n);
    for (const m of adj.get(n)!) {
      const d = indeg.get(m)! - 1;
      indeg.set(m, d);
      if (d === 0) {
        // keep `ready` sorted for determinism
        const i = ready.findIndex((x) => x > m);
        if (i === -1) ready.push(m);
        else ready.splice(i, 0, m);
      }
    }
  }
  return order.length === nodes.length ? order : null;
}

/**
 * Find one directed cycle using only edges whose index passes `keep`.
 * Returns the cycle as a node list [v0, v1, ..., v0], or null if acyclic.
 */
export function findCycle(nodes: string[], edges: Edge[], keep: (i: number) => boolean): string[] | null {
  const adj = new Map<string, Array<{ to: string }>>();
  for (const n of nodes) adj.set(n, []);
  for (let i = 0; i < edges.length; i++) {
    if (!keep(i)) continue;
    adj.get(edges[i]!.from)!.push({ to: edges[i]!.to });
  }
  const WHITE = 0, GRAY = 1, BLACK = 2;
  const color = new Map<string, number>();
  for (const n of nodes) color.set(n, WHITE);
  const stack: string[] = [];

  const dfs = (u: string): string[] | null => {
    color.set(u, GRAY);
    stack.push(u);
    for (const { to } of adj.get(u)!) {
      const c = color.get(to)!;
      if (c === GRAY) {
        const start = stack.indexOf(to);
        return [...stack.slice(start), to];
      }
      if (c === WHITE) {
        const r = dfs(to);
        if (r) return r;
      }
    }
    stack.pop();
    color.set(u, BLACK);
    return null;
  };

  for (const n of nodes) {
    if (color.get(n) === WHITE) {
      const r = dfs(n);
      if (r) return r;
    }
  }
  return null;
}

/** BFS reachability over edges filtered by `keep`. */
export function reachable(from: string, to: string, edges: Edge[], keep: (i: number) => boolean): boolean {
  if (from === to) return true;
  const adj = new Map<string, string[]>();
  for (let i = 0; i < edges.length; i++) {
    if (!keep(i)) continue;
    const e = edges[i]!;
    if (!adj.has(e.from)) adj.set(e.from, []);
    adj.get(e.from)!.push(e.to);
  }
  const seen = new Set<string>([from]);
  const queue = [from];
  while (queue.length > 0) {
    const u = queue.shift()!;
    for (const v of adj.get(u) ?? []) {
      if (v === to) return true;
      if (!seen.has(v)) {
        seen.add(v);
        queue.push(v);
      }
    }
  }
  return false;
}

/** BFS shortest path (node list) over edges filtered by `keep`, or null. */
export function shortestPath(from: string, to: string, edges: Edge[], keep: (i: number) => boolean): string[] | null {
  if (from === to) return [from];
  const adj = new Map<string, string[]>();
  for (let i = 0; i < edges.length; i++) {
    if (!keep(i)) continue;
    const e = edges[i]!;
    if (!adj.has(e.from)) adj.set(e.from, []);
    adj.get(e.from)!.push(e.to);
  }
  for (const list of adj.values()) list.sort();
  const prev = new Map<string, string>();
  const seen = new Set<string>([from]);
  const queue = [from];
  while (queue.length > 0) {
    const u = queue.shift()!;
    for (const v of adj.get(u) ?? []) {
      if (seen.has(v)) continue;
      seen.add(v);
      prev.set(v, u);
      if (v === to) {
        const path = [v];
        let cur = v;
        while (cur !== from) {
          cur = prev.get(cur)!;
          path.push(cur);
        }
        return path.reverse();
      }
      queue.push(v);
    }
  }
  return null;
}
