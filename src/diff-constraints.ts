/**
 * Difference-constraint ("alias") store.
 *
 * Records constraints of the form `x - y = d` (d is a bigint) between
 * variables, answers difference queries, and supports snapshot/rollback.
 *
 * Internally this is a weighted union-find (potentials on tree edges)
 * with union-by-size and an explicit undo log instead of path
 * compression, so rollback is a matter of replaying the log backwards.
 *
 * Contradictory constraints are rejected (the store is left untouched)
 * and the tree path witnessing the contradiction is returned as evidence.
 */

export type VarId = string | number;

/** A single constraint edge: `a - b = d`. */
export interface ConstraintEdge {
  a: VarId;
  b: VarId;
  d: bigint;
}

export type AddResult =
  | { ok: true; redundant: boolean }
  | {
      ok: false;
      /** Constraints already implied `a - b = existing`. */
      existing: bigint;
      /** The rejected constraint's right-hand side. */
      requested: bigint;
      /**
       * Chain of already-accepted constraints leading from `a` to `b`
       * whose differences sum to `existing` — the proof of conflict.
       */
      evidence: ConstraintEdge[];
    };

export type QueryResult =
  | { known: true; diff: bigint }
  | { known: false };

/** Opaque snapshot handle; pass back to {@link DiffConstraints.rollback}. */
export type Snapshot = number;

type UndoEntry =
  | { kind: "create"; node: VarId }
  | { kind: "union"; child: VarId; parent: VarId; parentSize: number };

export class DiffConstraints {
  /** parent[x] === x for roots; every node has an entry. */
  private parent = new Map<VarId, VarId>();
  /** weight[x] = x - parent[x] (0 for roots). */
  private weight = new Map<VarId, bigint>();
  /** Tree size, meaningful only at roots. */
  private size = new Map<VarId, number>();
  private log: UndoEntry[] = [];

  /** Number of recorded undo entries (monotonic outside rollback). */
  get logLength(): number {
    return this.log.length;
  }

  /** Capture the current state; later restorable via rollback. */
  snapshot(): Snapshot {
    return this.log.length;
  }

  /** Undo every operation recorded after `snap` was taken. */
  rollback(snap: Snapshot): void {
    if (!Number.isInteger(snap) || snap < 0 || snap > this.log.length) {
      throw new RangeError(`invalid snapshot: ${snap}`);
    }
    while (this.log.length > snap) {
      const entry = this.log.pop()!;
      if (entry.kind === "create") {
        this.parent.delete(entry.node);
        this.weight.delete(entry.node);
        this.size.delete(entry.node);
      } else {
        this.parent.set(entry.child, entry.child);
        this.weight.set(entry.child, 0n);
        this.size.set(entry.parent, entry.parentSize);
      }
    }
  }

  /** Does the store know this variable at all? */
  has(x: VarId): boolean {
    return this.parent.has(x);
  }

  /**
   * Query the implied difference `x - y`.
   * Returns `{ known: false }` when either variable is unknown or the two
   * live in disconnected components.
   */
  query(x: VarId, y: VarId): QueryResult {
    if (!this.parent.has(x) || !this.parent.has(y)) return { known: false };
    const fx = this.find(x);
    const fy = this.find(y);
    if (fx.root !== fy.root) return { known: false };
    return { known: true, diff: fx.pot - fy.pot };
  }

  /**
   * Record the constraint `x - y = d`.
   * On contradiction the store is not modified and the returned result
   * carries the evidence path proving the conflict.
   */
  add(x: VarId, y: VarId, d: bigint): AddResult {
    if (x === y) {
      // x - x is always 0: trivially true or a self-contradiction.
      if (d === 0n) {
        this.touch(x);
        return { ok: true, redundant: true };
      }
      return { ok: false, existing: 0n, requested: d, evidence: [] };
    }
    this.touch(x);
    this.touch(y);
    const fx = this.find(x);
    const fy = this.find(y);

    if (fx.root === fy.root) {
      const existing = fx.pot - fy.pot;
      if (existing === d) return { ok: true, redundant: true };
      return {
        ok: false,
        existing,
        requested: d,
        evidence: this.pathEdges(x, y),
      };
    }

    // Union by size. Attaching rx under ry requires
    //   weight[rx] = rx - ry = d - (x - rx) + (y - ry).
    let rx = fx.root;
    let ry = fy.root;
    let w = d - fx.pot + fy.pot; // rx - ry
    if (this.size.get(rx)! > this.size.get(ry)!) {
      [rx, ry] = [ry, rx];
      w = -w;
    }
    const parentSize = this.size.get(ry)!;
    this.parent.set(rx, ry);
    this.weight.set(rx, w);
    this.size.set(ry, parentSize + this.size.get(rx)!);
    this.log.push({ kind: "union", child: rx, parent: ry, parentSize });
    return { ok: true, redundant: false };
  }

  private touch(x: VarId): void {
    if (this.parent.has(x)) return;
    this.parent.set(x, x);
    this.weight.set(x, 0n);
    this.size.set(x, 1);
    this.log.push({ kind: "create", node: x });
  }

  /** Root of x plus potential `pot = x - root`. No path compression. */
  private find(x: VarId): { root: VarId; pot: bigint } {
    let pot = 0n;
    let node = x;
    for (;;) {
      const p = this.parent.get(node)!;
      if (p === node) return { root: node, pot };
      pot += this.weight.get(node)!;
      node = p;
    }
  }

  /**
   * Tree path from x to y (same component assumed) as a chain of
   * constraint edges whose `d` values sum to `x - y`.
   */
  private pathEdges(x: VarId, y: VarId): ConstraintEdge[] {
    // Chain from x up to the root: edge (node, parent) means node - parent = w.
    const upX: ConstraintEdge[] = [];
    const depth = new Map<VarId, number>();
    let node = x;
    depth.set(node, 0);
    while (this.parent.get(node)! !== node) {
      const p = this.parent.get(node)!;
      upX.push({ a: node, b: p, d: this.weight.get(node)! });
      node = p;
      depth.set(node, upX.length);
    }

    // Walk y upward until hitting x's ancestor chain (the LCA).
    const upY: ConstraintEdge[] = [];
    node = y;
    while (!depth.has(node)) {
      const p = this.parent.get(node)!;
      upY.push({ a: node, b: p, d: this.weight.get(node)! });
      node = p;
    }

    // x → LCA as-is, then LCA → y by flipping y's upward chain.
    const path = upX.slice(0, depth.get(node)!);
    for (let i = upY.length - 1; i >= 0; i--) {
      const e = upY[i];
      path.push({ a: e.b, b: e.a, d: -e.d });
    }
    return path;
  }
}
