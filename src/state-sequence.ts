/**
 * 状态序列库：每个样本自其时间戳起生效，直到下一个样本或自身 TTL 到期
 * （两者取先）。TTL 到期产生的空洞不会被后续样本向前延长填补。
 * 同一时间戳的更正以版本号高者为准（严格更高才替换，等于或更低被拒绝）。
 */

export interface Sample<V> {
  /** 整数 tick 时间戳 */
  readonly t: number;
  /** 更正版本号，同一时间戳下版本高者生效 */
  readonly version: number;
  readonly value: V;
  /** 有效时长（tick 数），省略表示一直持有到下一个样本 */
  readonly ttl?: number;
}

/** 半开区间 [start, end) 上的最大等值段 */
export interface Segment<V> {
  readonly start: number;
  readonly end: number;
  readonly value: V;
}

function assertSample<V>(sample: Sample<V>): void {
  if (!Number.isInteger(sample.t)) {
    throw new TypeError(`sample.t 必须是整数，收到 ${sample.t}`);
  }
  if (!Number.isInteger(sample.version) || sample.version < 0) {
    throw new TypeError(`sample.version 必须是非负整数，收到 ${sample.version}`);
  }
  if (sample.ttl !== undefined) {
    if (!Number.isInteger(sample.ttl) || sample.ttl <= 0) {
      throw new TypeError(`sample.ttl 必须是正整数，收到 ${sample.ttl}`);
    }
  }
}

/** 返回 times 中第一个 > t 的下标（upper bound） */
function upperBound(times: readonly number[], t: number): number {
  let lo = 0;
  let hi = times.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (times[mid]! <= t) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

export class StateSequence<V> {
  private readonly times: number[] = [];
  private readonly samples = new Map<number, Sample<V>>();
  private readonly equals: (a: V, b: V) => boolean;

  constructor(equals: (a: V, b: V) => boolean = Object.is) {
    this.equals = equals;
  }

  get size(): number {
    return this.times.length;
  }

  has(t: number): boolean {
    return this.samples.has(t);
  }

  get(t: number): Sample<V> | undefined {
    return this.samples.get(t);
  }

  /**
   * 插入样本。若该时间戳已有样本，仅当新版本号严格更高时替换（更正）。
   * 返回是否真正生效。
   */
  insert(sample: Sample<V>): boolean {
    assertSample(sample);
    const existing = this.samples.get(sample.t);
    if (existing !== undefined) {
      if (sample.version <= existing.version) return false;
      this.samples.set(sample.t, sample);
      return true;
    }
    const idx = upperBound(this.times, sample.t);
    this.times.splice(idx, 0, sample.t);
    this.samples.set(sample.t, sample);
    return true;
  }

  /** 删除恰好位于 t 的样本，返回是否存在并被删除 */
  delete(t: number): boolean {
    if (!this.samples.has(t)) return false;
    this.samples.delete(t);
    const idx = upperBound(this.times, t) - 1;
    this.times.splice(idx, 1);
    return true;
  }

  /** 单个 tick 上的生效值；空洞中返回 undefined */
  at(tick: number): V | undefined {
    const idx = upperBound(this.times, tick) - 1;
    if (idx < 0) return undefined;
    const s = this.samples.get(this.times[idx]!)!;
    if (s.ttl !== undefined && tick >= s.t + s.ttl) return undefined;
    return s.value;
  }

  /**
   * 范围查询：输出 [start, end) 内的最大等值半开段序列。
   * 空洞（无生效样本）不出现在输出中；相邻同值段被合并为最大段。
   */
  query(start: number, end: number): Segment<V>[] {
    if (!Number.isInteger(start) || !Number.isInteger(end)) {
      throw new TypeError("query 的 start/end 必须是整数");
    }
    if (end <= start) return [];

    const segments: Segment<V>[] = [];
    const emit = (segStart: number, segEnd: number, value: V): void => {
      const last = segments[segments.length - 1];
      if (last !== undefined && last.end === segStart && this.equals(last.value, value)) {
        segments[segments.length - 1] = { start: last.start, end: segEnd, value: last.value };
      } else {
        segments.push({ start: segStart, end: segEnd, value });
      }
    };

    let idx = upperBound(this.times, start) - 1; // 最后一个 t <= start 的样本，或 -1
    let cursor = start;

    while (cursor < end) {
      const nextT = idx + 1 < this.times.length ? this.times[idx + 1]! : Infinity;
      if (idx < 0) {
        // 首个样本之前的空洞
        if (nextT === Infinity || nextT >= end) break;
        cursor = nextT;
        idx = 0;
        continue;
      }
      const s = this.samples.get(this.times[idx]!)!;
      const ttlEnd = s.ttl !== undefined ? s.t + s.ttl : Infinity;
      const validEnd = Math.min(ttlEnd, nextT);
      if (cursor < validEnd) {
        emit(cursor, Math.min(validEnd, end), s.value);
        if (validEnd >= end) break;
        if (ttlEnd < nextT) {
          // TTL 先于下一样本到期：跳过空洞，空洞不被延长
          if (nextT >= end) break;
          cursor = nextT;
          idx += 1;
          continue;
        }
        cursor = validEnd; // === nextT，由下一样本接管
        idx += 1;
        continue;
      }
      // cursor 已落在 TTL 空洞里：跳到下一个样本
      if (nextT === Infinity || nextT >= end) break;
      cursor = nextT;
      idx += 1;
    }
    return segments;
  }
}
