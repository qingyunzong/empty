import { GAP_CAP, distanceToMissing, effectiveWeight } from "./weights.js";
import { sourceDigest } from "./digest.js";
import { cloneCell, validateSample, type Cell, type Sample } from "./types.js";

/** 窗口加权平均结果。 */
export interface WindowResult {
  /** 加权平均值 = Σ(w·v) / Σw。 */
  average: number;
  /** 窗口内有效权重之和。 */
  totalWeight: number;
  /** 窗口内有效样本个数（至多 k 个）。 */
  count: number;
  /** 窗口中最旧样本的时间位置。 */
  from: number;
  /** 窗口右端（查询终点）。 */
  to: number;
}

/** 未闭合窗口状态：流式末尾尚未封窗的最近 k 个有效样本位置。 */
export interface OpenWindowState {
  k: number;
  members: number[];
}

interface CheckpointPayload {
  version: 1;
  cells: Cell[];
  openWindow: OpenWindowState;
  digest: string;
}

export class SourceDigestMismatchError extends Error {
  constructor(expected: string, actual: string) {
    super(`source digest mismatch: checkpoint=${expected} source=${actual}`);
    this.name = "SourceDigestMismatchError";
  }
}

/**
 * 直接分数计算（对照用）：不依赖任何增量缓存，
 * 从原始单元逐个重新推导有效权重后求窗口加权平均。
 */
export function directWindowAverage(
  cells: readonly Cell[],
  end: number,
  k: number,
): WindowResult | null {
  if (!Number.isInteger(k) || k <= 0) {
    throw new RangeError("k must be a positive integer");
  }
  if (!Number.isInteger(end) || end < 0 || end >= cells.length) {
    throw new RangeError("end out of range");
  }
  let sumW = 0;
  let sumV = 0;
  let count = 0;
  let from = -1;
  for (let t = end; t >= 0 && count < k; t--) {
    const c = cells[t];
    if (c === null) continue; // 缺失样本占时间位置但不计权重
    const w = effectiveWeight(
      c.weight,
      t,
      distanceToMissing(cells, t, -1),
      distanceToMissing(cells, t, 1),
    );
    sumW += w;
    sumV += w * c.value;
    count++;
    from = t;
  }
  if (sumW === 0) return null; // 全零权重返回空
  return { average: sumV / sumW, totalWeight: sumW, count, from, to: end };
}

/**
 * 信号序列：维护有效权重的增量缓存，
 * 支持更正、删除、追加、检查点暂停/恢复与分支视图。
 */
export class SignalSeries {
  readonly windowSize: number;
  private cells: Cell[];
  /** 每个时间位置的有效权重缓存（缺失位置为 0）。 */
  private eff: number[];

  constructor(windowSize: number, cells: readonly Cell[] = []) {
    if (!Number.isInteger(windowSize) || windowSize <= 0) {
      throw new RangeError("windowSize must be a positive integer");
    }
    this.windowSize = windowSize;
    this.cells = cells.map((c) => (c === null ? null : validateSample(c)));
    this.eff = new Array<number>(this.cells.length).fill(0);
    this.recomputeAll();
  }

  get length(): number {
    return this.cells.length;
  }

  at(t: number): Cell {
    this.checkPosition(t);
    return cloneCell(this.cells[t]);
  }

  snapshot(): Cell[] {
    return this.cells.map(cloneCell);
  }

  /** 当前源摘要。 */
  digest(): string {
    return sourceDigest(this.cells);
  }

  /** 位置 t 当前缓存的有效权重（缺失位置为 0）。 */
  effectiveWeightAt(t: number): number {
    this.checkPosition(t);
    return this.eff[t];
  }

  append(cell: Cell): void {
    this.cells.push(cell === null ? null : validateSample(cell));
    this.eff.push(0);
    this.recomputeAround(this.cells.length - 1);
  }

  /** 更正位置 t 的样本。 */
  correct(t: number, sample: Sample): void {
    this.checkPosition(t);
    this.cells[t] = validateSample(sample);
    this.recomputeAround(t);
  }

  /** 删除位置 t 的样本：该位置变为缺失（仍占时间位置）。 */
  delete(t: number): void {
    this.checkPosition(t);
    this.cells[t] = null;
    this.recomputeAround(t);
  }

  /**
   * 最近 k 个有效样本的加权平均（增量缓存路径）。
   * 窗口内有效权重之和为 0（全零权重）时返回 null。
   */
  windowAverage(end?: number, k: number = this.windowSize): WindowResult | null {
    const e = end ?? this.cells.length - 1;
    if (!Number.isInteger(k) || k <= 0) {
      throw new RangeError("k must be a positive integer");
    }
    if (!Number.isInteger(e) || e < 0 || e >= this.cells.length) {
      throw new RangeError("end out of range");
    }
    let sumW = 0;
    let sumV = 0;
    let count = 0;
    let from = -1;
    for (let t = e; t >= 0 && count < k; t--) {
      if (this.cells[t] === null) continue;
      const w = this.eff[t];
      sumW += w;
      sumV += w * this.cells[t]!.value;
      count++;
      from = t;
    }
    if (sumW === 0) return null;
    return { average: sumV / sumW, totalWeight: sumW, count, from, to: e };
  }

  /** 未闭合窗口：末尾最近 windowSize 个有效样本的位置。 */
  openWindow(): OpenWindowState {
    const members: number[] = [];
    for (let t = this.cells.length - 1; t >= 0 && members.length < this.windowSize; t--) {
      if (this.cells[t] !== null) members.push(t);
    }
    return { k: this.windowSize, members: members.reverse() };
  }

  /** 检查点：序列化未闭合窗口与源摘要，供暂停后恢复。 */
  checkpoint(): string {
    const payload: CheckpointPayload = {
      version: 1,
      cells: this.snapshot(),
      openWindow: this.openWindow(),
      digest: this.digest(),
    };
    return JSON.stringify(payload);
  }

  /**
   * 从检查点恢复：必须提供源数据，校验源摘要一致，
   * 并核对未闭合窗口与源数据吻合，否则拒绝恢复。
   */
  static resume(payloadJson: string, source: readonly Cell[]): SignalSeries {
    const payload = JSON.parse(payloadJson) as CheckpointPayload;
    if (payload.version !== 1) {
      throw new Error(`unsupported checkpoint version: ${payload.version}`);
    }
    const actual = sourceDigest(source);
    if (actual !== payload.digest) {
      throw new SourceDigestMismatchError(payload.digest, actual);
    }
    const series = new SignalSeries(payload.openWindow.k, source);
    const restored = series.openWindow();
    if (
      restored.k !== payload.openWindow.k ||
      restored.members.length !== payload.openWindow.members.length ||
      !restored.members.every((m, i) => m === payload.openWindow.members[i])
    ) {
      throw new Error("unclosed window state does not match source");
    }
    return series;
  }

  /** 分支：返回独立副本，分支上的更正/删除不影响旧视图。 */
  branch(): SignalSeries {
    return new SignalSeries(this.windowSize, this.snapshot());
  }

  private checkPosition(t: number): void {
    if (!Number.isInteger(t) || t < 0 || t >= this.cells.length) {
      throw new RangeError(`position out of range: ${t}`);
    }
  }

  private computeEffAt(t: number): number {
    const c = this.cells[t];
    if (c === null) return 0;
    return effectiveWeight(
      c.weight,
      t,
      distanceToMissing(this.cells, t, -1),
      distanceToMissing(this.cells, t, 1),
    );
  }

  private recomputeAll(): void {
    for (let t = 0; t < this.cells.length; t++) {
      this.eff[t] = this.computeEffAt(t);
    }
  }

  /**
   * 局部重算：位置 t 的变更只影响距离不超过 GAP_CAP 的邻近位置
   * （缺测邻近因子的作用范围），删除样本因此会改变相邻权重。
   */
  private recomputeAround(t: number): void {
    const lo = Math.max(0, t - GAP_CAP);
    const hi = Math.min(this.cells.length - 1, t + GAP_CAP);
    for (let i = lo; i <= hi; i++) {
      this.eff[i] = this.computeEffAt(i);
    }
  }
}
