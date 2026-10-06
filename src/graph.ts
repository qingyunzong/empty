export type NodeId = string;

export interface EdgeOp {
  readonly type: 'add' | 'remove';
  readonly from: NodeId;
  readonly to: NodeId;
}

export interface BatchResult {
  /** Sources whose reachable set / shortest paths may have changed, sorted ascending. */
  readonly affectedSources: NodeId[];
}

interface SourceCache {
  /** dist.get(v) = shortest distance from the cached source to v. */
  readonly dist: Map<NodeId, number>;
}

function validateOp(op: unknown, index: number): EdgeOp {
  if (typeof op !== 'object' || op === null) {
    throw new TypeError(`op[${index}] must be an object`);
  }
  const { type, from, to } = op as Record<string, unknown>;
  if (type !== 'add' && type !== 'remove') {
    throw new TypeError(`op[${index}].type must be 'add' or 'remove'`);
  }
  if (typeof from !== 'string' || from.length === 0) {
    throw new TypeError(`op[${index}].from must be a non-empty string`);
  }
  if (typeof to !== 'string' || to.length === 0) {
    throw new TypeError(`op[${index}].to must be a non-empty string`);
  }
  return { type, from, to };
}

export class DirectedGraph {
  private readonly outAdj = new Map<NodeId, Set<NodeId>>();
  private readonly inAdj = new Map<NodeId, Set<NodeId>>();
  private readonly cache = new Map<NodeId, SourceCache>();

  addEdge(from: NodeId, to: NodeId): BatchResult {
    return this.applyBatch([{ type: 'add', from, to }]);
  }

  removeEdge(from: NodeId, to: NodeId): BatchResult {
    return this.applyBatch([{ type: 'remove', from, to }]);
  }

  hasNode(node: NodeId): boolean {
    return this.outAdj.has(node);
  }

  hasEdge(from: NodeId, to: NodeId): boolean {
    return this.outAdj.get(from)?.has(to) ?? false;
  }

  nodes(): NodeId[] {
    return [...this.outAdj.keys()].sort();
  }

  edges(): Array<readonly [NodeId, NodeId]> {
    const result: Array<readonly [NodeId, NodeId]> = [];
    for (const from of this.nodes()) {
      for (const to of [...(this.outAdj.get(from) ?? [])].sort()) {
        result.push([from, to]);
      }
    }
    return result;
  }

  /** Number of sources currently holding cached BFS results (test/diagnostic aid). */
  get cachedSourceCount(): number {
    return this.cache.size;
  }

  /**
   * Applies all ops atomically: every op is validated before any mutation,
   * so an invalid op leaves the graph untouched. Self-loops are allowed.
   * Returns the sorted set of sources whose reachability may have changed;
   * their cache entries are invalidated.
   */
  applyBatch(ops: readonly EdgeOp[]): BatchResult {
    const validated = ops.map((op, index) => validateOp(op, index));

    // Net effect only: edges whose presence is the same before and after the
    // batch (including edges flipped back and forth within it) are no-ops.
    const flips: Array<{ from: NodeId; to: NodeId; add: boolean }> = [];
    {
      const pending = new Map<string, { from: NodeId; to: NodeId; present: boolean }>();
      for (const op of validated) {
        const k = JSON.stringify([op.from, op.to]);
        const entry = pending.get(k) ?? {
          from: op.from,
          to: op.to,
          present: this.hasEdge(op.from, op.to),
        };
        entry.present = op.type === 'add';
        pending.set(k, entry);
      }
      for (const { from, to, present } of pending.values()) {
        if (present !== this.hasEdge(from, to)) flips.push({ from, to, add: present });
      }
    }

    // A source can only gain/lose reachability through a flipped edge (u -> v)
    // if it reaches u in the old or the new graph. Union of both is sound.
    const affected = new Set<NodeId>();
    for (const flip of flips) {
      for (const s of this.reverseReachable(flip.from)) affected.add(s);
    }

    for (const flip of flips) {
      if (flip.add) this.link(flip.from, flip.to);
      else this.unlink(flip.from, flip.to);
    }

    for (const flip of flips) {
      for (const s of this.reverseReachable(flip.from)) affected.add(s);
    }

    for (const source of affected) this.cache.delete(source);
    return { affectedSources: [...affected].sort() };
  }

  /** True when `to` is reachable from `from` (every node reaches itself). */
  reachable(from: NodeId, to: NodeId): boolean {
    return this.distancesFrom(from).has(to);
  }

  /**
   * Shortest path from `from` to `to` as a node list, or null if unreachable.
   * Among equal-length shortest paths, returns the lexicographically
   * smallest node sequence. shortestPath(x, x) is always [x].
   */
  shortestPath(from: NodeId, to: NodeId): NodeId[] | null {
    if (!this.distancesFrom(from).has(to)) return null;
    if (from === to) return [from];

    // Distance-to-target via reverse BFS from `to`.
    const toTarget = new Map<NodeId, number>([[to, 0]]);
    const queue: NodeId[] = [to];
    for (let head = 0; head < queue.length; head++) {
      const cur = queue[head]!;
      const d = toTarget.get(cur)!;
      for (const prev of this.inAdj.get(cur) ?? []) {
        if (!toTarget.has(prev)) {
          toTarget.set(prev, d + 1);
          queue.push(prev);
        }
      }
    }

    // Greedy: at each step take the smallest neighbor still on a shortest path.
    const path: NodeId[] = [from];
    let cur = from;
    while (cur !== to) {
      const want = toTarget.get(cur)! - 1;
      let best: NodeId | undefined;
      for (const next of this.outAdj.get(cur) ?? []) {
        if (toTarget.get(next) === want && (best === undefined || next < best)) {
          best = next;
        }
      }
      if (best === undefined) return null; // unreachable state, defensive
      path.push(best);
      cur = best;
    }
    return path;
  }

  private distancesFrom(source: NodeId): Map<NodeId, number> {
    const hit = this.cache.get(source);
    if (hit) return hit.dist;
    const dist = new Map<NodeId, number>([[source, 0]]);
    const queue: NodeId[] = [source];
    for (let head = 0; head < queue.length; head++) {
      const cur = queue[head]!;
      const d = dist.get(cur)!;
      for (const next of this.outAdj.get(cur) ?? []) {
        if (!dist.has(next)) {
          dist.set(next, d + 1);
          queue.push(next);
        }
      }
    }
    this.cache.set(source, { dist });
    return dist;
  }

  private reverseReachable(target: NodeId): Set<NodeId> {
    const seen = new Set<NodeId>([target]);
    const queue: NodeId[] = [target];
    for (let head = 0; head < queue.length; head++) {
      const cur = queue[head]!;
      for (const prev of this.inAdj.get(cur) ?? []) {
        if (!seen.has(prev)) {
          seen.add(prev);
          queue.push(prev);
        }
      }
    }
    return seen;
  }

  private link(from: NodeId, to: NodeId): void {
    this.ensureNode(from);
    this.ensureNode(to);
    this.outAdj.get(from)!.add(to);
    this.inAdj.get(to)!.add(from);
  }

  private unlink(from: NodeId, to: NodeId): void {
    this.outAdj.get(from)?.delete(to);
    this.inAdj.get(to)?.delete(from);
  }

  private ensureNode(node: NodeId): void {
    if (!this.outAdj.has(node)) this.outAdj.set(node, new Set());
    if (!this.inAdj.has(node)) this.inAdj.set(node, new Set());
  }
}
