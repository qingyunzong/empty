import type { LogEvent, Requirement } from "./model.js";

/**
 * Returns requirement indices in an order where every prerequisite appears
 * before its dependents (Kahn's algorithm). Throws on cyclic dependencies.
 */
export function topoOrder(reqs: readonly Requirement[]): number[] {
  const n = reqs.length;
  const indeg = new Array<number>(n).fill(0);
  const dependents: number[][] = Array.from({ length: n }, () => []);
  for (let i = 0; i < n; i++) {
    for (const p of reqs[i]!.prereqs ?? []) {
      if (p < 0 || p >= n || p === i) {
        throw new Error(`invalid prerequisite index ${p} on requirement ${i}`);
      }
      indeg[i]!++;
      dependents[p]!.push(i);
    }
  }
  const queue: number[] = [];
  for (let i = 0; i < n; i++) if (indeg[i] === 0) queue.push(i);
  const order: number[] = [];
  while (queue.length > 0) {
    const cur = queue.shift()!;
    order.push(cur);
    for (const d of dependents[cur]!) {
      indeg[d]!--;
      if (indeg[d] === 0) queue.push(d);
    }
  }
  if (order.length !== n) {
    throw new Error("prerequisite dependencies contain a cycle");
  }
  return order;
}

/**
 * Backtracking search for a legal one-to-one matching between requirements
 * and events in the inclusive index range [lo, hi].
 *
 * Returns an array `match` where `match[reqIndex]` is the absolute event
 * index, or null when no legal matching exists.
 */
export function findMatching(
  events: readonly LogEvent[],
  lo: number,
  hi: number,
  reqs: readonly Requirement[],
  order: readonly number[],
): number[] | null {
  const match = new Array<number>(reqs.length).fill(-1);
  const used = new Array<boolean>(events.length).fill(false);
  const groupSources = new Map<string, Set<string>>();
  let usedCount = 0;

  function dfs(t: number): boolean {
    if (t === order.length) return true;
    // Pigeonhole prune: not enough free events left in the window.
    if (order.length - t > hi - lo + 1 - usedCount) return false;
    const ri = order[t]!;
    const req = reqs[ri]!;
    let minPos = lo;
    for (const p of req.prereqs ?? []) {
      const pPos = match[p]!;
      if (pPos + 1 > minPos) minPos = pPos + 1;
    }
    for (let pos = minPos; pos <= hi; pos++) {
      if (used[pos]) continue;
      const ev = events[pos]!;
      if (!ev.keywords.includes(req.keyword)) continue;
      if (req.mutexGroup !== undefined) {
        const sources = groupSources.get(req.mutexGroup);
        if (sources !== undefined && sources.has(ev.source)) continue;
      }
      match[ri] = pos;
      used[pos] = true;
      usedCount++;
      if (req.mutexGroup !== undefined) {
        let sources = groupSources.get(req.mutexGroup);
        if (sources === undefined) {
          sources = new Set();
          groupSources.set(req.mutexGroup, sources);
        }
        sources.add(ev.source);
      }
      if (dfs(t + 1)) return true;
      if (req.mutexGroup !== undefined) {
        groupSources.get(req.mutexGroup)!.delete(ev.source);
      }
      usedCount--;
      used[pos] = false;
      match[ri] = -1;
    }
    return false;
  }

  return dfs(0) ? match : null;
}

/**
 * Validates a matching certificate against the constraints. Returns null
 * when the matching is legal, otherwise a human-readable reason.
 */
export function validateMatching(
  events: readonly LogEvent[],
  lo: number,
  hi: number,
  reqs: readonly Requirement[],
  match: readonly number[],
): string | null {
  if (match.length !== reqs.length) {
    return `matching has ${match.length} entries, expected ${reqs.length}`;
  }
  const seen = new Set<number>();
  for (let i = 0; i < match.length; i++) {
    const pos = match[i]!;
    if (!Number.isInteger(pos) || pos < lo || pos > hi) {
      return `requirement ${i} matched to out-of-range position ${pos}`;
    }
    if (seen.has(pos)) {
      return `event at position ${pos} satisfies more than one requirement`;
    }
    seen.add(pos);
    if (!events[pos]!.keywords.includes(reqs[i]!.keyword)) {
      return `event at position ${pos} lacks keyword "${reqs[i]!.keyword}"`;
    }
  }
  for (let i = 0; i < reqs.length; i++) {
    for (const p of reqs[i]!.prereqs ?? []) {
      if (match[i]! <= match[p]!) {
        return `requirement ${i} must be matched after prerequisite ${p}`;
      }
    }
  }
  const groupSources = new Map<string, Map<string, number>>();
  for (let i = 0; i < reqs.length; i++) {
    const group = reqs[i]!.mutexGroup;
    if (group === undefined) continue;
    const source = events[match[i]!]!.source;
    let sources = groupSources.get(group);
    if (sources === undefined) {
      sources = new Map();
      groupSources.set(group, sources);
    }
    const other = sources.get(source);
    if (other !== undefined) {
      return `requirements ${other} and ${i} in mutex group "${group}" share source "${source}"`;
    }
    sources.set(source, i);
  }
  return null;
}
