/**
 * Rollback-capable union-find (disjoint set union).
 *
 * Semantics:
 * - merge(a, b): union the components of a and b. Every call — including
 *   merges of already-connected members — occupies one slot in the
 *   operation history, so rollback restores the exact prior state.
 * - snapshot(): push a marker onto the snapshot stack; returns its token.
 * - rollback(token?): undo every merge recorded after the given snapshot
 *   (or the most recent snapshot when no token is given) and pop it.
 * - find(x): identity of x's component, defined as the minimum member id.
 *
 * Rollback safety: parent links are only ever redirected by merge and
 * restored by rollback, so path compression is forbidden. Union by size
 * keeps find at O(log n) without it.
 */

interface MergeRecord {
  /** Root that was attached, or -1 when the merge was a no-op. */
  child: number;
  /** Root that absorbed `child`, or -1 when the merge was a no-op. */
  parent: number;
  /** `size[parent]` before the merge (only meaningful when child >= 0). */
  parentSize: number;
  /** `minId[parent]` before the merge (only meaningful when child >= 0). */
  parentMin: number;
}

const NOOP: MergeRecord = { child: -1, parent: -1, parentSize: 0, parentMin: 0 };

export class RollbackDSU {
  private readonly parent: number[];
  private readonly size: number[];
  private readonly minId: number[];
  private readonly history: MergeRecord[] = [];
  private readonly snapshots: number[] = [];
  private componentCount: number;

  constructor(readonly n: number) {
    if (!Number.isInteger(n) || n <= 0) {
      throw new RangeError("n must be a positive integer");
    }
    this.parent = new Array<number>(n);
    this.size = new Array<number>(n);
    this.minId = new Array<number>(n);
    for (let i = 0; i < n; i++) {
      this.parent[i] = i;
      this.size[i] = 1;
      this.minId[i] = i;
    }
    this.componentCount = n;
  }

  private checkMember(x: number): void {
    if (!Number.isInteger(x) || x < 0 || x >= this.n) {
      throw new RangeError(`member id out of range: ${x}`);
    }
  }

  /** Current operation count; snapshots and rollback are expressed in it. */
  get operationCount(): number {
    return this.history.length;
  }

  get components(): number {
    return this.componentCount;
  }

  /** Snapshot stack depth. */
  get snapshotCount(): number {
    return this.snapshots.length;
  }

  /** Root of x's component. Internal: walks parents without compression. */
  private root(x: number): number {
    let cur = x;
    while (this.parent[cur] !== cur) {
      cur = this.parent[cur]!;
    }
    return cur;
  }

  /** Identity of x's component: the minimum member id in it. */
  find(x: number): number {
    this.checkMember(x);
    return this.minId[this.root(x)]!;
  }

  connected(a: number, b: number): boolean {
    this.checkMember(a);
    this.checkMember(b);
    return this.root(a) === this.root(b);
  }

  /**
   * Union the components of a and b. Returns true when two previously
   * separate components were joined. Either way the call is recorded in
   * the operation history, so rollback accounts for repeated merges too.
   */
  merge(a: number, b: number): boolean {
    this.checkMember(a);
    this.checkMember(b);
    let ra = this.root(a);
    let rb = this.root(b);
    if (ra === rb) {
      this.history.push(NOOP);
      return false;
    }
    if (this.size[ra]! < this.size[rb]!) {
      const tmp = ra;
      ra = rb;
      rb = tmp;
    }
    this.history.push({
      child: rb,
      parent: ra,
      parentSize: this.size[ra]!,
      parentMin: this.minId[ra]!,
    });
    this.parent[rb] = ra;
    this.size[ra] = this.size[ra]! + this.size[rb]!;
    this.minId[ra] = Math.min(this.minId[ra]!, this.minId[rb]!);
    this.componentCount--;
    return true;
  }

  /** Push a snapshot of the current operation frontier; returns its token. */
  snapshot(): number {
    this.snapshots.push(this.history.length);
    return this.snapshots.length - 1;
  }

  /**
   * Undo every merge recorded after a snapshot and pop it.
   * With no argument, rolls back to the most recent snapshot.
   * A token from snapshot() rolls back that snapshot and every newer one.
   */
  rollback(token?: number): void {
    if (this.snapshots.length === 0) {
      throw new Error("rollback without a matching snapshot");
    }
    let target: number;
    if (token === undefined) {
      target = this.snapshots.pop()!;
    } else {
      if (!Number.isInteger(token) || token < 0 || token >= this.snapshots.length) {
        throw new RangeError(`unknown snapshot token: ${token}`);
      }
      target = this.snapshots[token]!;
      this.snapshots.length = token;
    }
    while (this.history.length > target) {
      const rec = this.history.pop()!;
      if (rec.child < 0) continue; // repeated merge: occupied a slot, changed nothing
      this.parent[rec.child] = rec.child;
      this.size[rec.parent] = rec.parentSize;
      this.minId[rec.parent] = rec.parentMin;
      this.componentCount++;
    }
  }
}
