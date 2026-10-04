/**
 * 逐 tick 参考解释器：朴素实现，用于核对 StateSequence 的插入/删除/查询。
 * 对每个整数 tick 独立求值，再扫描出最大等值半开段。
 */
import type { Sample, Segment } from "../src/state-sequence.js";

export class TickInterpreter<V> {
  private readonly samples: Sample<V>[] = [];
  private readonly equals: (a: V, b: V) => boolean;

  constructor(equals: (a: V, b: V) => boolean = Object.is) {
    this.equals = equals;
  }

  insert(sample: Sample<V>): boolean {
    const i = this.samples.findIndex((s) => s.t === sample.t);
    if (i >= 0) {
      if (sample.version <= this.samples[i]!.version) return false;
      this.samples[i] = sample;
      return true;
    }
    this.samples.push(sample);
    return true;
  }

  delete(t: number): boolean {
    const i = this.samples.findIndex((s) => s.t === t);
    if (i < 0) return false;
    this.samples.splice(i, 1);
    return true;
  }

  /** 单个 tick 求值：取 t <= tick 的最新样本，TTL 到期则为空洞 */
  valueAt(tick: number): V | undefined {
    let best: Sample<V> | undefined;
    for (const s of this.samples) {
      if (s.t <= tick && (best === undefined || s.t > best.t)) best = s;
    }
    if (best === undefined) return undefined;
    if (best.ttl !== undefined && tick >= best.t + best.ttl) return undefined;
    return best.value;
  }

  /** 逐 tick 扫描 [start, end)，合并出最大等值半开段 */
  interpret(start: number, end: number): Segment<V>[] {
    const segments: Segment<V>[] = [];
    let open: { start: number; value: V } | undefined;
    for (let tick = start; tick < end; tick++) {
      const v = this.valueAt(tick);
      if (v === undefined) {
        if (open !== undefined) {
          segments.push({ start: open.start, end: tick, value: open.value });
          open = undefined;
        }
        continue;
      }
      if (open !== undefined && this.equals(open.value, v)) continue;
      if (open !== undefined) {
        segments.push({ start: open.start, end: tick, value: open.value });
      }
      open = { start: tick, value: v };
    }
    if (open !== undefined) {
      segments.push({ start: open.start, end, value: open.value });
    }
    return segments;
  }
}
