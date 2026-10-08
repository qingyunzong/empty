export type Snapshot = number;

interface MergeRecord {
  childRoot: number;
  parentRoot: number;
  childMin: number;
  parentMin: number;
  parentSize: number;
}

/**
 * 支持快照与回滚的并查集（连通库）。
 *
 * - union：合并两个元素所在集合；即使已连通（重复合并）也占用一个操作序号。
 * - snapshot：返回当前操作序号（历史长度），之后可用于回滚。
 * - rollback：撤销快照之后的所有合并（含重复合并占用的序号）。
 * - find：返回所在连通分量的最小成员 ID。
 *
 * 为保证回滚正确性，find 不做路径压缩（压缩会丢失父指针历史）；
 * 仅使用按大小合并，find 复杂度 O(log n)。
 */
export class RollbackDSU {
  private readonly parent: number[];
  private readonly size: number[];
  private readonly min: number[];
  private readonly history: (MergeRecord | null)[] = [];

  constructor(n: number) {
    if (!Number.isInteger(n) || n <= 0) {
      throw new RangeError(`size must be a positive integer, got ${n}`);
    }
    this.parent = Array.from({ length: n }, (_, i) => i);
    this.size = new Array<number>(n).fill(1);
    this.min = Array.from({ length: n }, (_, i) => i);
  }

  get count(): number {
    return this.parent.length;
  }

  /** 当前操作序号：已执行的 union 次数（重复合并也计入）。 */
  get opCount(): number {
    return this.history.length;
  }

  private checkIndex(x: number): void {
    if (!Number.isInteger(x) || x < 0 || x >= this.parent.length) {
      throw new RangeError(`element ${x} out of range [0, ${this.parent.length})`);
    }
  }

  private root(x: number): number {
    this.checkIndex(x);
    // 禁止路径压缩：回滚依赖父指针的完整历史，压缩会破坏可撤销性。
    let cur = x;
    while (this.parent[cur] !== cur) {
      cur = this.parent[cur];
    }
    return cur;
  }

  /** 返回 x 所在连通分量的最小成员 ID。 */
  find(x: number): number {
    return this.min[this.root(x)];
  }

  connected(a: number, b: number): boolean {
    return this.root(a) === this.root(b);
  }

  componentSize(x: number): number {
    return this.size[this.root(x)];
  }

  /**
   * 合并 a、b 所在集合。返回是否真正发生了合并；
   * 已连通时不改动结构，但仍占用一个操作序号。
   */
  union(a: number, b: number): boolean {
    let ra = this.root(a);
    let rb = this.root(b);
    if (ra === rb) {
      this.history.push(null);
      return false;
    }
    if (this.size[ra] < this.size[rb]) {
      const tmp = ra;
      ra = rb;
      rb = tmp;
    }
    this.history.push({
      childRoot: rb,
      parentRoot: ra,
      childMin: this.min[rb],
      parentMin: this.min[ra],
      parentSize: this.size[ra],
    });
    this.parent[rb] = ra;
    this.size[ra] += this.size[rb];
    this.min[ra] = Math.min(this.min[ra], this.min[rb]);
    return true;
  }

  /** 记录当前操作序号，供 rollback 使用。 */
  snapshot(): Snapshot {
    return this.history.length;
  }

  /** 撤销快照之后的所有合并（含重复合并占用的序号）。 */
  rollback(snap: Snapshot): void {
    if (!Number.isInteger(snap) || snap < 0 || snap > this.history.length) {
      throw new RangeError(
        `invalid snapshot ${snap}, valid range is [0, ${this.history.length}]`,
      );
    }
    while (this.history.length > snap) {
      const rec = this.history.pop();
      if (rec == null) {
        continue;
      }
      this.parent[rec.childRoot] = rec.childRoot;
      this.size[rec.parentRoot] = rec.parentSize;
      this.min[rec.parentRoot] = rec.parentMin;
      this.min[rec.childRoot] = rec.childMin;
    }
  }
}
