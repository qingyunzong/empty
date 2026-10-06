export interface ConstraintEdge {
  from: string;
  to: string;
  /** from - to = diff */
  diff: bigint;
}

export type QueryResult =
  | { kind: 'known'; diff: bigint }
  | { kind: 'unknown' };

export type AddResult =
  | { ok: true }
  | {
      ok: false;
      reason: 'contradiction';
      /** difference x - y implied by the constraints already stored */
      implied: bigint;
      /**
       * Cycle of edges proving the conflict: every stored path edge
       * (x ~~> y, telescoping to `implied`) followed by the rejected
       * constraint traversed backwards (y -> x, diff = -d).
       * The diffs sum to `implied - d`, which is non-zero.
       */
      evidence: ConstraintEdge[];
    };

interface UndoEntry {
  child: string;
  parent: string;
  parentSize: number;
}

/**
 * Difference-constraint store over string variable aliases.
 *
 * Records constraints of the form `x - y = d` (bigint arithmetic) in a
 * weighted union-find without path compression, which keeps parent chains
 * intact so unions can be undone: `snapshot()` returns an opaque handle and
 * `rollback(handle)` restores the exact prior state.
 *
 * `query(x, y)` returns the implied difference, or `unknown` when the two
 * variables live in disconnected components (or were never constrained).
 * A contradicting `add` is rejected, leaves the store untouched, and
 * returns the evidence cycle that proves the conflict.
 */
export class DifferenceConstraints {
  private parent = new Map<string, string>();
  /** weight[x] = x - parent[x] */
  private weight = new Map<string, bigint>();
  private size = new Map<string, number>();
  private history: UndoEntry[] = [];

  private ensure(x: string): void {
    if (!this.parent.has(x)) {
      this.parent.set(x, x);
      this.weight.set(x, 0n);
      this.size.set(x, 1);
    }
  }

  /** Root of x plus its potential: x - root. */
  private find(x: string): { root: string; pot: bigint } {
    let pot = 0n;
    let cur = x;
    while (this.parent.get(cur) !== cur) {
      pot += this.weight.get(cur)!;
      cur = this.parent.get(cur)!;
    }
    return { root: cur, pot };
  }

  has(x: string): boolean {
    return this.parent.has(x);
  }

  /** Record `x - y = diff`. Rejects contradictions without mutating state. */
  add(x: string, y: string, diff: bigint): AddResult {
    if (x === y) {
      // x - x is always 0; a non-zero self-constraint contradicts it.
      if (diff === 0n) {
        this.ensure(x);
        return { ok: true };
      }
      return {
        ok: false,
        reason: 'contradiction',
        implied: 0n,
        evidence: [{ from: x, to: x, diff: -diff }],
      };
    }
    if (this.parent.has(x) && this.parent.has(y)) {
      const fx = this.find(x);
      const fy = this.find(y);
      if (fx.root === fy.root) {
        const implied = fx.pot - fy.pot;
        if (implied === diff) return { ok: true };
        return {
          ok: false,
          reason: 'contradiction',
          implied,
          evidence: this.evidenceCycle(x, y, diff),
        };
      }
    }
    this.ensure(x);
    this.ensure(y);
    const fx = this.find(x);
    const fy = this.find(y);
    const sx = this.size.get(fx.root)!;
    const sy = this.size.get(fy.root)!;
    if (sx >= sy) {
      // Attach fy.root under fx.root: need x - y = diff, i.e.
      // (fy.root - fx.root) = fx.pot - fy.pot - diff.
      this.parent.set(fy.root, fx.root);
      this.weight.set(fy.root, fx.pot - fy.pot - diff);
      this.size.set(fx.root, sx + sy);
      this.history.push({ child: fy.root, parent: fx.root, parentSize: sx });
    } else {
      // Attach fx.root under fy.root:
      // (fx.root - fy.root) = diff - fx.pot + fy.pot.
      this.parent.set(fx.root, fy.root);
      this.weight.set(fx.root, diff - fx.pot + fy.pot);
      this.size.set(fy.root, sx + sy);
      this.history.push({ child: fx.root, parent: fy.root, parentSize: sy });
    }
    return { ok: true };
  }

  query(x: string, y: string): QueryResult {
    if (x === y) return { kind: 'known', diff: 0n };
    if (!this.parent.has(x) || !this.parent.has(y)) return { kind: 'unknown' };
    const fx = this.find(x);
    const fy = this.find(y);
    if (fx.root !== fy.root) return { kind: 'unknown' };
    return { kind: 'known', diff: fx.pot - fy.pot };
  }

  /**
   * Opaque handle to the current state; pass to `rollback` later.
   * Rolling back past a snapshot invalidates its handle.
   */
  snapshot(): number {
    return this.history.length;
  }

  /** Undo every union recorded after `snap` was taken. */
  rollback(snap: number): void {
    if (!Number.isInteger(snap) || snap < 0 || snap > this.history.length) {
      throw new RangeError(`invalid snapshot handle: ${snap}`);
    }
    while (this.history.length > snap) {
      const undo = this.history.pop()!;
      this.parent.set(undo.child, undo.child);
      this.weight.set(undo.child, 0n);
      this.size.set(undo.parent, undo.parentSize);
    }
  }

  /** Edges (cur, parent, cur - parent) from x up to its root. */
  private chainToRoot(x: string): ConstraintEdge[] {
    const edges: ConstraintEdge[] = [];
    let cur = x;
    while (this.parent.get(cur) !== cur) {
      const next = this.parent.get(cur)!;
      edges.push({ from: cur, to: next, diff: this.weight.get(cur)! });
      cur = next;
    }
    return edges;
  }

  private evidenceCycle(x: string, y: string, diff: bigint): ConstraintEdge[] {
    const up = this.chainToRoot(x);
    const down = this.chainToRoot(y)
      .reverse()
      .map((e) => ({ from: e.to, to: e.from, diff: -e.diff }));
    return [...up, ...down, { from: y, to: x, diff: -diff }];
  }
}
