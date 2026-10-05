import { NormalizedProblem } from "./types";

/** adjacency of the graph formed by the given edge indices */
export function buildAdjacency(p: NormalizedProblem, keep: (i: number) => boolean): Map<string, { to: string; edge: number }[]> {
  const adj = new Map<string, { to: string; edge: number }[]>();
  for (const n of p.nodes) adj.set(n, []);
  for (let i = 0; i < p.edges.length; i++) {
    if (!keep(i)) continue;
    const e = p.edges[i]!;
    adj.get(e.from)!.push({ to: e.to, edge: i });
  }
  for (const list of adj.values()) list.sort((a, b) => (a.to < b.to ? -1 : 1));
  return adj;
}

/** Kahn topological order; null if the graph has a cycle */
export function topoOrder(p: NormalizedProblem, keep: (i: number) => boolean): string[] | null {
  const indeg = new Map<string, number>();
  for (const n of p.nodes) indeg.set(n, 0);
  const adj = buildAdjacency(p, keep);
  for (const [, list] of adj) for (const { to } of list) indeg.set(to, (indeg.get(to) ?? 0) + 1);
  const queue = p.nodes.filter((n) => indeg.get(n) === 0).sort();
  const order: string[] = [];
  while (queue.length) {
    const n = queue.shift()!;
    order.push(n);
    for (const { to } of adj.get(n) ?? []) {
      const d = indeg.get(to)! - 1;
      indeg.set(to, d);
      if (d === 0) {
        // keep deterministic order
        const pos = queue.findIndex((x) => x > to);
        if (pos === -1) queue.push(to);
        else queue.splice(pos, 0, to);
      }
    }
  }
  return order.length === p.nodes.length ? order : null;
}

/** find one directed cycle (as node list, first==last implied) using only kept edges; null if acyclic */
export function findCycle(p: NormalizedProblem, keep: (i: number) => boolean): string[] | null {
  const adj = buildAdjacency(p, keep);
  const state = new Map<string, number>(); // 0=unvisited 1=in-stack 2=done
  const stack: string[] = [];
  const dfs = (n: string): string[] | null => {
    state.set(n, 1);
    stack.push(n);
    for (const { to } of adj.get(n) ?? []) {
      const s = state.get(to) ?? 0;
      if (s === 0) {
        const r = dfs(to);
        if (r) return r;
      } else if (s === 1) {
        const idx = stack.indexOf(to);
        return [...stack.slice(idx), to];
      }
    }
    stack.pop();
    state.set(n, 2);
    return null;
  };
  for (const n of p.nodes) {
    if ((state.get(n) ?? 0) === 0) {
      const r = dfs(n);
      if (r) return r;
    }
  }
  return null;
}

/** BFS reachability using only kept edges */
export function reachable(p: NormalizedProblem, keep: (i: number) => boolean, from: string, to: string): boolean {
  if (from === to) return true;
  const adj = buildAdjacency(p, keep);
  const seen = new Set<string>([from]);
  const queue = [from];
  while (queue.length) {
    const n = queue.shift()!;
    for (const { to: m } of adj.get(n) ?? []) {
      if (m === to) return true;
      if (!seen.has(m)) {
        seen.add(m);
        queue.push(m);
      }
    }
  }
  return false;
}

/** shortest path (fewest edges) from->to using kept edges; returns node path + edge indices, or null */
export function shortestPath(
  p: NormalizedProblem,
  keep: (i: number) => boolean,
  from: string,
  to: string
): { nodes: string[]; edges: number[] } | null {
  const adj = buildAdjacency(p, keep);
  const prev = new Map<string, { node: string; edge: number }>();
  const seen = new Set<string>([from]);
  const queue = [from];
  while (queue.length) {
    const n = queue.shift()!;
    if (n === to) break;
    for (const { to: m, edge } of adj.get(n) ?? []) {
      if (!seen.has(m)) {
        seen.add(m);
        prev.set(m, { node: n, edge });
        queue.push(m);
      }
    }
  }
  if (from !== to && !seen.has(to)) return null;
  const nodes: string[] = [];
  const edges: number[] = [];
  let cur = to;
  nodes.push(cur);
  while (cur !== from) {
    const pr = prev.get(cur);
    if (!pr) return null;
    edges.unshift(pr.edge);
    cur = pr.node;
    nodes.unshift(cur);
  }
  return { nodes, edges };
}
