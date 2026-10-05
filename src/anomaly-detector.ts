/**
 * 异常段检测器。
 *
 * 事件点按 (value, id) 升序维护；相邻点之间构成一条边，
 * 边的值差（右值 - 左值）严格大于 threshold 时称为异常边。
 * 极大连续异常边序列构成异常段，段 ID 取成员点中最小的 id。
 *
 * 插入点会把一条旧边拆成两条新边，删除点会把两条旧边合并为一条新边；
 * 每次变更只在受影响的点区间局部重建段，而不是全量重扫。
 * fullScan() 提供完整边扫描的对照实现，用于校验增量结果。
 */

export interface Segment {
  /** 段 ID：成员点中最小的 id */
  id: number;
  /** 成员点 id，按值升序 */
  memberIds: number[];
  /** 段内异常边数量（= memberIds.length - 1） */
  edgeCount: number;
  /** 段首点的值 */
  startValue: number;
  /** 段末点的值 */
  endValue: number;
}

export interface Point {
  id: number;
  value: number;
}

interface RawSegment {
  /** 首成员点在 points 中的下标（含） */
  start: number;
  /** 末成员点在 points 中的下标（含） */
  end: number;
}

export class AnomalyDetector {
  private readonly threshold: number;
  private points: Point[] = [];
  private segs: RawSegment[] = [];
  private readonly valueById = new Map<number, number>();

  constructor(threshold: number) {
    if (!Number.isFinite(threshold) || threshold < 0) {
      throw new RangeError("threshold must be a non-negative finite number");
    }
    this.threshold = threshold;
  }

  get size(): number {
    return this.points.length;
  }

  has(id: number): boolean {
    return this.valueById.has(id);
  }

  /** 插入事件点；id 重复时抛错。 */
  insert(id: number, value: number): void {
    if (this.valueById.has(id)) {
      throw new Error(`duplicate id: ${id}`);
    }
    if (!Number.isFinite(value)) {
      throw new RangeError("value must be a finite number");
    }
    const pos = this.lowerBound(value, id);
    this.points.splice(pos, 0, { id, value });
    this.valueById.set(id, value);
    // 旧下标 >= pos 的点右移一位，同步修正段下标
    for (const seg of this.segs) {
      if (seg.start >= pos) {
        seg.start += 1;
        seg.end += 1;
      } else if (seg.end >= pos) {
        // 插入点落在某段的下标跨度内部：段先向右扩一格，边结构稍后局部重建
        seg.end += 1;
      }
    }
    // 旧边 (pos-1, pos) 被拆成 (pos-1, pos) 与 (pos, pos+1) 两条新边
    this.rebuildAround(pos - 1, pos + 1);
  }

  /** 删除事件点；id 不存在时返回 false。 */
  delete(id: number): boolean {
    const value = this.valueById.get(id);
    if (value === undefined) {
      return false;
    }
    const pos = this.lowerBound(value, id);
    this.points.splice(pos, 1);
    this.valueById.delete(id);
    // 旧下标 > pos 的点左移一位，同步修正段下标
    for (const seg of this.segs) {
      if (seg.start > pos) {
        seg.start -= 1;
        seg.end -= 1;
      } else if (seg.end >= pos) {
        // 段包含被删点：先收缩一格（可能退化），稍后局部重建
        seg.end -= 1;
      }
    }
    // 旧边 (pos-1, pos)、(pos, pos+1) 合并为新边 (pos-1, pos)
    this.rebuildAround(pos - 1, pos);
    return true;
  }

  /** 当前异常段（增量维护的结果）。 */
  segments(): Segment[] {
    return this.segs.map((seg) => this.toSegment(seg));
  }

  /** 对照实现：完整扫描所有边，重新计算异常段。 */
  fullScan(): Segment[] {
    const result: Segment[] = [];
    let runStart = -1;
    for (let edge = 0; edge + 1 < this.points.length; edge += 1) {
      if (this.isAnomalousEdge(edge)) {
        if (runStart === -1) runStart = edge;
      } else if (runStart !== -1) {
        result.push(this.toSegment({ start: runStart, end: edge }));
        runStart = -1;
      }
    }
    if (runStart !== -1) {
      result.push(this.toSegment({ start: runStart, end: this.points.length - 1 }));
    }
    return result;
  }

  /** 点集快照，按 (value, id) 升序。 */
  snapshot(): Point[] {
    return this.points.map((p) => ({ ...p }));
  }

  private isAnomalousEdge(edge: number): boolean {
    return this.points[edge + 1].value - this.points[edge].value > this.threshold;
  }

  /** 第一个大于 (value, id) 的位置。 */
  private lowerBound(value: number, id: number): number {
    let lo = 0;
    let hi = this.points.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      const p = this.points[mid];
      if (p.value < value || (p.value === value && p.id < id)) {
        lo = mid + 1;
      } else {
        hi = mid;
      }
    }
    return lo;
  }

  /**
   * 局部重建：移除与点区间 [a, b] 相交的段，
   * 重扫该区间内的边并生成新的极大异常段。
   */
  private rebuildAround(a: number, b: number): void {
    const n = this.points.length;
    if (n < 2) {
      this.segs.length = 0;
      return;
    }
    let lo = Math.max(0, a);
    let hi = Math.min(n - 1, b);
    let first = -1;
    let last = -1;
    for (let i = 0; i < this.segs.length; i += 1) {
      const seg = this.segs[i];
      if (seg.end < lo || seg.start > hi) continue;
      if (first === -1) first = i;
      last = i;
      if (seg.start < lo) lo = seg.start;
      if (seg.end > hi) hi = seg.end;
    }
    const rebuilt: RawSegment[] = [];
    let runStart = -1;
    for (let edge = lo; edge < hi; edge += 1) {
      if (this.isAnomalousEdge(edge)) {
        if (runStart === -1) runStart = edge;
      } else if (runStart !== -1) {
        rebuilt.push({ start: runStart, end: edge });
        runStart = -1;
      }
    }
    if (runStart !== -1) {
      rebuilt.push({ start: runStart, end: hi });
    }
    if (first === -1) {
      let at = 0;
      while (at < this.segs.length && this.segs[at].end < lo) at += 1;
      this.segs.splice(at, 0, ...rebuilt);
    } else {
      this.segs.splice(first, last - first + 1, ...rebuilt);
    }
  }

  private toSegment(seg: RawSegment): Segment {
    const members = this.points.slice(seg.start, seg.end + 1);
    const memberIds = new Array<number>(members.length);
    let minId = members[0].id;
    for (let i = 0; i < members.length; i += 1) {
      memberIds[i] = members[i].id;
      if (members[i].id < minId) minId = members[i].id;
    }
    return {
      id: minId,
      memberIds,
      edgeCount: members.length - 1,
      startValue: members[0].value,
      endValue: members[members.length - 1].value,
    };
  }
}
