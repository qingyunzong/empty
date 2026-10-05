import { MAX_REQUIREMENTS } from "./types.js";
import type { LogEvent, Requirement } from "./types.js";

/** Canonical event ordering: by time, then by id. */
export function compareEvents(a: LogEvent, b: LogEvent): number {
  if (a.time !== b.time) return a.time - b.time;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/** Validate requirement slots: count limit, dependency range, acyclicity. */
export function validateRequirements(reqs: readonly Requirement[]): void {
  if (reqs.length === 0) {
    throw new Error("at least one requirement is needed");
  }
  if (reqs.length > MAX_REQUIREMENTS) {
    throw new Error(
      `at most ${MAX_REQUIREMENTS} requirements supported, got ${reqs.length}`,
    );
  }
  for (let i = 0; i < reqs.length; i++) {
    for (const d of reqs[i]!.dependsOn ?? []) {
      if (!Number.isInteger(d) || d < 0 || d >= reqs.length) {
        throw new Error(
          `requirement ${i} depends on out-of-range requirement ${d}`,
        );
      }
      if (d === i) {
        throw new Error(`requirement ${i} depends on itself`);
      }
    }
  }
  topoOrder(reqs); // throws on dependency cycles
}

/** Kahn's topological sort over the dependency DAG. Throws on cycles. */
export function topoOrder(reqs: readonly Requirement[]): number[] {
  const indeg = new Array<number>(reqs.length).fill(0);
  const adj: number[][] = reqs.map(() => []);
  for (let i = 0; i < reqs.length; i++) {
    for (const d of reqs[i]!.dependsOn ?? []) {
      adj[d]!.push(i);
      indeg[i]!++;
    }
  }
  const queue: number[] = [];
  for (let i = 0; i < reqs.length; i++) {
    if (indeg[i] === 0) queue.push(i);
  }
  const order: number[] = [];
  while (queue.length > 0) {
    const u = queue.shift()!;
    order.push(u);
    for (const v of adj[u]!) {
      indeg[v]!--;
      if (indeg[v] === 0) queue.push(v);
    }
  }
  if (order.length !== reqs.length) {
    throw new Error("requirement dependencies contain a cycle");
  }
  return order;
}

/**
 * Solver matcher: backtracking search over requirements in topological
 * order with pruning (dependency lower bound, used events, mutex sources).
 * Returns a requirement -> event-index map, or null if infeasible.
 */
export function findMatching(
  events: readonly LogEvent[],
  reqs: readonly Requirement[],
  lo: number,
  hi: number,
  order: readonly number[],
): Map<number, number> | null {
  const assigned = new Map<number, number>();
  const usedEvents = new Set<number>();
  const groupSources = new Map<string, Set<string>>();
  const depsOf = reqs.map((r) => r.dependsOn ?? []);

  function place(pos: number): boolean {
    if (pos === order.length) return true;
    const r = order[pos]!;
    const req = reqs[r]!;
    let minIdx = lo;
    for (const d of depsOf[r]!) {
      const depIdx = assigned.get(d);
      if (depIdx === undefined) return false; // unreachable in topo order
      if (depIdx + 1 > minIdx) minIdx = depIdx + 1;
    }
    const group = req.mutexGroup;
    const usedSources = group !== undefined ? groupSources.get(group) : undefined;
    for (let e = minIdx; e <= hi; e++) {
      if (usedEvents.has(e)) continue;
      const ev = events[e]!;
      if (!ev.keywords.includes(req.keyword)) continue;
      if (usedSources !== undefined && usedSources.has(ev.source)) continue;
      assigned.set(r, e);
      usedEvents.add(e);
      if (group !== undefined) {
        if (usedSources !== undefined) usedSources.add(ev.source);
        else groupSources.set(group, new Set([ev.source]));
      }
      if (place(pos + 1)) return true;
      assigned.delete(r);
      usedEvents.delete(e);
      if (group !== undefined) groupSources.get(group)!.delete(ev.source);
    }
    return false;
  }

  return place(0) ? assigned : null;
}

/**
 * Independent verifier matcher: deliberately naive enumeration of every
 * injective assignment of distinct in-window events to requirement slots,
 * checking all constraints only at the leaf. Shares no logic with the
 * solver matcher, so it can cross-check it.
 */
export function bruteForceMatching(
  events: readonly LogEvent[],
  reqs: readonly Requirement[],
  lo: number,
  hi: number,
): Map<number, number> | null {
  const k = reqs.length;
  const chosen = new Array<number>(k).fill(-1);
  const used = new Set<number>();

  function legal(a: readonly number[]): boolean {
    for (let r = 0; r < k; r++) {
      const ev = events[a[r]!]!;
      const req = reqs[r]!;
      if (!ev.keywords.includes(req.keyword)) return false;
      for (const d of req.dependsOn ?? []) {
        if (a[d]! >= a[r]!) return false;
      }
    }
    const groupSeen = new Map<string, Set<string>>();
    for (let r = 0; r < k; r++) {
      const g = reqs[r]!.mutexGroup;
      if (g === undefined) continue;
      const src = events[a[r]!]!.source;
      const seen = groupSeen.get(g) ?? new Set<string>();
      if (seen.has(src)) return false;
      seen.add(src);
      groupSeen.set(g, seen);
    }
    return true;
  }

  function go(r: number): Map<number, number> | null {
    if (r === k) {
      if (!legal(chosen)) return null;
      const m = new Map<number, number>();
      for (let i = 0; i < k; i++) m.set(i, chosen[i]!);
      return m;
    }
    for (let e = lo; e <= hi; e++) {
      if (used.has(e)) continue;
      used.add(e);
      chosen[r] = e;
      const res = go(r + 1);
      if (res) return res;
      used.delete(e);
      chosen[r] = -1;
    }
    return null;
  }

  return go(0);
}
