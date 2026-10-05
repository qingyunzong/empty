import { Graph } from "./graph.js";
import { MinHeap } from "./heap.js";
import { compareKeys, keyOf } from "./types.js";

export interface OrderDiagnostics {
  /** missing dependency id -> event ids directly blocked on it. */
  missing: Record<string, string[]>;
  /** withheld event id -> root missing dependency ids causing the withhold. */
  withheld: Record<string, string[]>;
  /**
   * Concrete dependency cycles. In each cycle [x0..xk], every xi depends on
   * x(i+1) and xk depends on x0.
   */
  cycles: string[][];
}

export interface OrderResult {
  /** Deterministic topological order of all emittable events. */
  order: string[];
  /** Ready candidates (indegree 0) right after the fixed prefix, key-sorted. */
  candidates: string[];
  diagnostics: OrderDiagnostics;
}

function idComparator(g: Graph): (a: string, b: string) => number {
  return (a, b) => compareKeys(keyOf(g.events.get(a)!), keyOf(g.events.get(b)!));
}

/**
 * Deterministic topological order (Kahn's algorithm with a min-heap):
 * each round, among all events whose dependencies are already emitted, the
 * candidate with the smallest (ts, source, seq, id) key is emitted next.
 *
 * Timestamps are only a tie-break key; they are NOT required to be causally
 * monotonic, so a child with a smaller timestamp than its parent is still
 * ordered after the parent.
 *
 * Events with missing dependencies (directly or transitively) are withheld
 * and reported; events on or downstream of dependency cycles are reported
 * with concrete cycle evidence.
 *
 * `prefix` is an optional fixed, already-published prefix: it is emitted
 * first, verbatim, and validated to be causally consistent.
 */
export function deterministicOrder(g: Graph, prefix: string[] = []): OrderResult {
  const indeg = new Map<string, number>();
  for (const id of g.events.keys()) {
    // Missing dependencies count as unsatisfiable indegree: the event (and
    // its transitive dependents) stays withheld and is reported as evidence.
    indeg.set(id, g.presentDeps.get(id)!.length + g.directMissing.get(id)!.length);
  }
  const cmp = idComparator(g);
  const heap = new MinHeap<string>(cmp);
  const emitted = new Set<string>();
  const order: string[] = [];
  const release = (id: string): void => {
    for (const d of g.dependents.get(id)!) {
      const v = indeg.get(d)! - 1;
      indeg.set(d, v);
      if (v === 0) heap.push(d);
    }
  };

  // Seed with initially-ready events before emitting the prefix, so that
  // events released by the prefix cannot be pushed twice.
  for (const id of g.events.keys()) {
    if (indeg.get(id)! === 0) heap.push(id);
  }
  for (const pid of prefix) {
    if (!g.events.has(pid)) throw new Error(`published event not found: ${pid}`);
    if (emitted.has(pid)) throw new Error(`duplicate published event: ${pid}`);
    for (const d of g.presentDeps.get(pid)!) {
      if (!emitted.has(d)) {
        throw new Error(
          `invalid published prefix: ${pid} depends on ${d}, which is not published earlier`
        );
      }
    }
    if (g.directMissing.get(pid)!.length > 0) {
      throw new Error(
        `invalid published prefix: ${pid} has missing dependencies: ${g.directMissing.get(pid)!.join(", ")}`
      );
    }
    emitted.add(pid);
    order.push(pid);
    release(pid);
  }

  const candidates = heap.snapshotSorted().filter((id) => !emitted.has(id));

  while (heap.size > 0) {
    const id = heap.pop()!;
    if (emitted.has(id)) continue;
    emitted.add(id);
    order.push(id);
    release(id);
  }

  // Diagnostics: split unemitted events into withheld (missing deps) and cyclic.
  const unemitted = [...g.events.keys()].filter((id) => !emitted.has(id));
  const withheldOf = new Map<string, Set<string>>();
  for (const m of [...g.missingIndex.keys()].sort()) {
    const queue = [...g.missingIndex.get(m)!];
    while (queue.length > 0) {
      const u = queue.pop()!;
      let set = withheldOf.get(u);
      if (!set) {
        set = new Set<string>();
        withheldOf.set(u, set);
      }
      if (set.has(m)) continue;
      set.add(m);
      for (const d of g.dependents.get(u)!) queue.push(d);
    }
  }
  const withheld: Record<string, string[]> = {};
  for (const u of [...withheldOf.keys()].sort()) {
    withheld[u] = [...withheldOf.get(u)!].sort();
  }
  const cyclic = unemitted.filter((id) => !withheldOf.has(id));
  const cycles = findCycles(cyclic, (id) => g.presentDeps.get(id)!);
  const missing: Record<string, string[]> = {};
  for (const m of [...g.missingIndex.keys()].sort()) {
    missing[m] = [...g.missingIndex.get(m)!];
  }
  return { order, candidates, diagnostics: { missing, withheld, cycles } };
}

/**
 * Find concrete cycles among `nodes` (edges follow "depends on"). In each
 * returned cycle [x0..xk], xi depends on x(i+1) and xk depends on x0.
 */
export function findCycles(nodes: string[], depsOf: (id: string) => string[]): string[][] {
  const nodeSet = new Set(nodes);
  const color = new Map<string, number>(); // 1 = in stack, 2 = done
  const stack: string[] = [];
  const cycles: string[][] = [];
  const visit = (u: string): void => {
    if (cycles.length >= 20) return;
    color.set(u, 1);
    stack.push(u);
    for (const v of depsOf(u)) {
      if (!nodeSet.has(v)) continue;
      const c = color.get(v) ?? 0;
      if (c === 0) {
        visit(v);
      } else if (c === 1) {
        cycles.push(stack.slice(stack.indexOf(v)));
        if (cycles.length >= 20) {
          stack.pop();
          color.set(u, 2);
          return;
        }
      }
    }
    stack.pop();
    color.set(u, 2);
  };
  for (const u of [...nodes].sort()) {
    if ((color.get(u) ?? 0) === 0) visit(u);
  }
  return cycles;
}

/** Lexicographic comparison of two orders by event key. */
export function compareOrdersByKey(g: Graph, a: string[], b: string[]): number {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    const c = compareKeys(keyOf(g.events.get(a[i])!), keyOf(g.events.get(b[i])!));
    if (c !== 0) return c;
  }
  return a.length - b.length;
}

export interface EnumerationResult {
  /** Number of distinct topological orders found (capped by maxCount). */
  count: number;
  /** True if enumeration stopped early because maxCount was reached. */
  truncated: boolean;
  /** The lexicographically smallest order by (ts, source, seq, id). */
  best: string[] | null;
  /** Up to `keep` enumerated orders (for membership checks on tiny graphs). */
  orders: string[][];
}

/**
 * Enumerate all topological orders of a (complete, acyclic) graph by
 * backtracking. Intended for cross-checking the greedy order on small
 * graphs; `maxCount` bounds the work on larger ones.
 */
export function enumerateOrders(g: Graph, maxCount = 200000, keep = 1000): EnumerationResult {
  if (g.missingIndex.size > 0) {
    throw new Error("enumeration requires a complete graph (no missing dependencies)");
  }
  const cmp = idComparator(g);
  const indeg = new Map<string, number>();
  for (const id of g.events.keys()) indeg.set(id, g.presentDeps.get(id)!.length);
  const total = g.events.size;
  let ready = [...g.events.keys()].filter((id) => indeg.get(id)! === 0).sort(cmp);
  const result: EnumerationResult = { count: 0, truncated: false, best: null, orders: [] };
  const path: string[] = [];
  const visit = (): void => {
    if (result.count >= maxCount) {
      result.truncated = true;
      return;
    }
    if (path.length === total) {
      result.count++;
      if (result.orders.length < keep) result.orders.push([...path]);
      if (result.best === null || compareOrdersByKey(g, path, result.best) < 0) {
        result.best = [...path];
      }
      return;
    }
    for (const id of [...ready]) {
      ready = ready.filter((x) => x !== id);
      path.push(id);
      const added: string[] = [];
      for (const d of g.dependents.get(id)!) {
        const v = indeg.get(d)! - 1;
        indeg.set(d, v);
        if (v === 0) {
          ready.push(d);
          added.push(d);
        }
      }
      ready.sort(cmp);
      visit();
      ready = ready.filter((x) => !added.includes(x));
      ready.push(id);
      ready.sort(cmp);
      path.pop();
      for (const d of g.dependents.get(id)!) indeg.set(d, indeg.get(d)! + 1);
      if (result.truncated) return;
    }
  };
  visit();
  return result;
}
