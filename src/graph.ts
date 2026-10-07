/**
 * Directed graph with:
 *  - edge add/remove, self-loops allowed
 *  - atomic batch modifications (validate + apply on a copy, swap on success)
 *  - per-source BFS distance cache
 *  - conservative "affected sources" invalidation: for every touched edge
 *    (u -> v), every source that could reach u in the pre-batch graph may
 *    observe a change, so its cache entry is dropped and reported.
 *  - shortest path queries; ties broken by the lexicographically smallest
 *    node sequence.
 */

export type EdgeOp =
  | { type: "add"; from: string; to: string }
  | { type: "remove"; from: string; to: string };

export interface BatchResult {
  /** Sources whose cached results were invalidated, sorted ascending. */
  affectedSources: string[];
}

export class BatchValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BatchValidationError";
  }
}

type Adjacency = Map<string, Set<string>>;

function cloneAdjacency(adj: Adjacency): Adjacency {
  const copy: Adjacency = new Map();
  for (const [node, succs] of adj) copy.set(node, new Set(succs));
  return copy;
}

function ensureNode(adj: Adjacency, node: string): void {
  if (!adj.has(node)) adj.set(node, new Set());
}

function validateNode(name: unknown, label: string): asserts name is string {
  if (typeof name !== "string" || name.length === 0) {
    throw new BatchValidationError(`${label} must be a non-empty string`);
  }
}

export class DirectedGraph {
  private adj: Adjacency = new Map();
  /** src -> (node -> shortest distance from src). Lazily computed. */
  private distCache = new Map<string, Map<string, number>>();

  /** All known nodes, sorted ascending. */
  nodes(): string[] {
    return [...this.adj.keys()].sort();
  }

  /** All edges as sorted [from, to] pairs. */
  edges(): Array<[string, string]> {
    const out: Array<[string, string]> = [];
    for (const [from, succs] of this.adj) {
      for (const to of succs) out.push([from, to]);
    }
    return out.sort((a, b) => (a[0] === b[0] ? (a[1] < b[1] ? -1 : 1) : a[0] < b[0] ? -1 : 1));
  }

  hasEdge(from: string, to: string): boolean {
    return this.adj.get(from)?.has(to) ?? false;
  }

  addEdge(from: string, to: string): BatchResult {
    return this.applyBatch([{ type: "add", from, to }]);
  }

  removeEdge(from: string, to: string): BatchResult {
    return this.applyBatch([{ type: "remove", from, to }]);
  }

  /**
   * Applies all ops atomically: ops are validated and applied to a private
   * copy; on any failure the graph is left untouched and a
   * BatchValidationError is thrown. On success the copy is swapped in and
   * the cache entries of all affected sources are dropped.
   *
   * Semantics within a batch are sequential: a later op observes earlier
   * ops. Adding an existing edge is a no-op; removing a missing edge fails.
   * Self-loops (from === to) are allowed.
   */
  applyBatch(ops: readonly EdgeOp[]): BatchResult {
    const next = cloneAdjacency(this.adj);
    for (const op of ops) {
      if (op === null || typeof op !== "object") {
        throw new BatchValidationError("op must be an object");
      }
      validateNode(op.from, "op.from");
      validateNode(op.to, "op.to");
      if (op.type === "add") {
        ensureNode(next, op.from);
        ensureNode(next, op.to);
        next.get(op.from)!.add(op.to);
      } else if (op.type === "remove") {
        if (!next.get(op.from)?.has(op.to)) {
          throw new BatchValidationError(`cannot remove missing edge ${op.from} -> ${op.to}`);
        }
        next.get(op.from)!.delete(op.to);
      } else {
        throw new BatchValidationError(`unknown op type: ${String((op as EdgeOp).type)}`);
      }
    }

    // Compute affected sources against the PRE-batch graph: any source that
    // can reach the tail of a touched edge may see its reachable set change
    // (growth for adds, shrinkage for removes). Conservative and sound.
    const affected = new Set<string>();
    for (const op of ops) {
      for (const src of this.ancestorsOf(op.from)) affected.add(src);
    }

    this.adj = next;
    for (const src of affected) this.distCache.delete(src);
    return { affectedSources: [...affected].sort() };
  }

  /** Nodes that can reach `target` (including `target` itself), via reverse BFS. */
  private ancestorsOf(target: string): Set<string> {
    const seen = new Set<string>([target]);
    const queue = [target];
    while (queue.length > 0) {
      const cur = queue.pop()!;
      for (const [node, succs] of this.adj) {
        if (!seen.has(node) && succs.has(cur)) {
          seen.add(node);
          queue.push(node);
        }
      }
    }
    return seen;
  }

  /** Cached BFS distances from `src` over the current graph. */
  private distFrom(src: string): Map<string, number> {
    const cached = this.distCache.get(src);
    if (cached) return cached;
    const dist = new Map<string, number>([[src, 0]]);
    const queue = [src];
    for (let head = 0; head < queue.length; head++) {
      const cur = queue[head]!;
      const d = dist.get(cur)!;
      for (const nxt of this.adj.get(cur) ?? []) {
        if (!dist.has(nxt)) {
          dist.set(nxt, d + 1);
          queue.push(nxt);
        }
      }
    }
    this.distCache.set(src, dist);
    return dist;
  }

  isReachable(src: string, dst: string): boolean {
    validateNode(src, "src");
    validateNode(dst, "dst");
    return this.distFrom(src).has(dst);
  }

  /** All nodes reachable from `src` (including `src`), sorted ascending. */
  reachableFrom(src: string): string[] {
    validateNode(src, "src");
    return [...this.distFrom(src).keys()].sort();
  }

  /** Shortest distance from `src` to `dst`, or null if unreachable. */
  distance(src: string, dst: string): number | null {
    validateNode(src, "src");
    validateNode(dst, "dst");
    return this.distFrom(src).get(dst) ?? null;
  }

  /**
   * Shortest path from `src` to `dst` as a node list (inclusive). Among
   * several shortest paths, returns the lexicographically smallest node
   * sequence. Returns null when `dst` is unreachable. `shortestPath(x, x)`
   * is `[x]` (length 0), whether or not a self-loop exists.
   */
  shortestPath(src: string, dst: string): string[] | null {
    validateNode(src, "src");
    validateNode(dst, "dst");
    if (!this.distFrom(src).has(dst)) return null;

    // Distance-to-dst via BFS on the reverse graph, starting at dst.
    const distToDst = new Map<string, number>([[dst, 0]]);
    const queue = [dst];
    for (let head = 0; head < queue.length; head++) {
      const cur = queue[head]!;
      const d = distToDst.get(cur)!;
      for (const [node, succs] of this.adj) {
        if (!distToDst.has(node) && succs.has(cur)) {
          distToDst.set(node, d + 1);
          queue.push(node);
        }
      }
    }

    // Greedy: from the current node, step to the lexicographically smallest
    // successor whose distance-to-dst is exactly one less. Because every
    // shortest path has the same length, minimizing the prefix at each step
    // yields the lexicographically smallest sequence overall.
    const path = [src];
    let cur = src;
    while (cur !== dst) {
      const d = distToDst.get(cur)!;
      let best: string | null = null;
      for (const nxt of this.adj.get(cur) ?? []) {
        if (distToDst.get(nxt) === d - 1 && (best === null || nxt < best)) best = nxt;
      }
      if (best === null) return null; // defensive; unreachable by construction
      path.push(best);
      cur = best;
    }
    return path;
  }

  /** Number of sources currently holding a cached BFS result (for tests). */
  get cacheSize(): number {
    return this.distCache.size;
  }
}
