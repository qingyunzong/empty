import {
  Interval,
  addInterval,
  removeInterval,
  intersect,
  covers,
} from "./intervals.js";
import { stronglyConnectedComponents } from "./scc.js";

/** 一段“至少 k 个服务可用”的最大区间，附带该段内恒定不变的支持服务集合（升序）。 */
export interface Segment {
  readonly start: number;
  readonly end: number;
  readonly services: readonly string[];
}

/** 订阅收到的净差更正：绑定到同一版本号。 */
export interface Correction {
  readonly version: number;
  readonly added: readonly Segment[];
  readonly removed: readonly Segment[];
}

export type Listener = (c: Correction) => void;

function segmentKey(s: Segment): string {
  return `${s.start}|${s.end}|${s.services.join(",")}`;
}

/**
 * 监控器：维护各服务在线区间与因果依赖，回答“至少 k 服务可用”的最大区间。
 * 依赖语义：依赖不可用则本服务不计可用；循环依赖组件只有全成员在线才可能计入。
 */
export class AvailabilityMonitor {
  private online = new Map<string, Interval[]>();
  private deps = new Map<string, Set<string>>();
  private subs = new Set<{ k: number; listener: Listener; last: Segment[] }>();
  version = 0;

  private services(): string[] {
    const all = new Set<string>([...this.online.keys(), ...this.deps.keys()]);
    for (const targets of this.deps.values()) {
      for (const t of targets) all.add(t);
    }
    return [...all].sort();
  }

  addInterval(service: string, start: number, end: number): void {
    const cur = this.online.get(service) ?? [];
    this.online.set(service, addInterval(cur, { start, end }));
    this.commit();
  }

  removeInterval(service: string, start: number, end: number): void {
    const cur = this.online.get(service) ?? [];
    this.online.set(service, removeInterval(cur, { start, end }));
    this.commit();
  }

  addDependency(service: string, dependsOn: string): void {
    if (service === dependsOn) {
      // 自环视为循环依赖组件（成员只有自己，仍要求自身在线，等价于无额外约束，
      // 但按“循环依赖组件”口径处理，保持与逐 tick 闭包一致）。
    }
    const cur = this.deps.get(service) ?? new Set<string>();
    cur.add(dependsOn);
    this.deps.set(service, cur);
    this.commit();
  }

  removeDependency(service: string, dependsOn: string): void {
    const cur = this.deps.get(service);
    if (cur) {
      cur.delete(dependsOn);
      if (cur.size === 0) this.deps.delete(service);
    }
    this.commit();
  }

  /** 当前原始在线区间（未做依赖闭包）。 */
  onlineIntervals(service: string): readonly Interval[] {
    return this.online.get(service) ?? [];
  }

  dependencies(service: string): readonly string[] {
    return [...(this.deps.get(service) ?? [])].sort();
  }

  /**
   * 依赖闭包后的有效可用区间：服务在其 SCC 全成员在线、且所有外部依赖的
   * 有效区间内的时段才算可用。
   */
  effectiveIntervals(): Map<string, Interval[]> {
    const nodes = this.services();
    const { components, indexOf } = stronglyConnectedComponents(nodes, (s) => [
      ...(this.deps.get(s) ?? []),
    ]);
    const effective = new Map<string, Interval[]>();
    // Tarjan 顺序保证被依赖的分量先处理。
    for (const comp of components) {
      let acc: Interval[] | null = null;
      const merge = (ivs: readonly Interval[]) => {
        acc = acc === null ? [...ivs] : intersect(acc, ivs);
      };
      for (const member of comp) {
        merge(this.online.get(member) ?? []);
      }
      for (const member of comp) {
        for (const dep of this.deps.get(member) ?? []) {
          if (indexOf.get(dep) !== indexOf.get(member)) {
            merge(effective.get(dep) ?? []);
          }
        }
      }
      for (const member of comp) effective.set(member, acc ?? []);
    }
    return effective;
  }

  /**
   * 扫描线：同一时刻先统一应用所有增减，再判定该点之后开区间内的计数。
   * 返回计数 >= k 的最大半开区间段，每段支持集合恒定。
   */
  compute(k: number): Segment[] {
    if (k <= 0) throw new Error(`k 必须为正整数，得到 ${k}`);
    const events = new Map<number, Map<string, number>>();
    for (const [service, ivs] of this.effectiveIntervals()) {
      for (const iv of ivs) {
        for (const [t, d] of [
          [iv.start, 1],
          [iv.end, -1],
        ] as const) {
          let m = events.get(t);
          if (!m) events.set(t, (m = new Map()));
          m.set(service, (m.get(service) ?? 0) + d);
        }
      }
    }
    const times = [...events.keys()].sort((a, b) => a - b);
    const active = new Set<string>();
    const out: Segment[] = [];
    for (let i = 0; i < times.length; i++) {
      const t = times[i]!;
      // 同点统一增减
      for (const [service, delta] of events.get(t)!) {
        if (delta > 0) active.add(service);
        else active.delete(service);
      }
      const next = i + 1 < times.length ? times[i + 1]! : null;
      if (next === null || next === t) continue;
      if (active.size < k) continue;
      const services = [...active].sort();
      const last = out[out.length - 1];
      if (last && last.end === t && last.services.join(",") === services.join(",")) {
        // 支持集合未变，延伸为最大区间
        out[out.length - 1] = { start: last.start, end: next, services };
      } else {
        out.push({ start: t, end: next, services });
      }
    }
    return out;
  }

  /** 订阅：立即收到当前快照（作为全量 added），之后每次变更收到净差更正。 */
  subscribe(k: number, listener: Listener): () => void {
    const sub = { k, listener, last: this.compute(k) };
    this.subs.add(sub);
    if (sub.last.length > 0) {
      listener({ version: this.version, added: sub.last, removed: [] });
    }
    return () => {
      this.subs.delete(sub);
    };
  }

  private commit(): void {
    this.version++;
    for (const sub of this.subs) {
      const next = this.compute(sub.k);
      const prevKeys = new Map(sub.last.map((s) => [segmentKey(s), s]));
      const nextKeys = new Map(next.map((s) => [segmentKey(s), s]));
      // 净差：两侧都存在的段抵消，不重复发送。
      const removed = sub.last.filter((s) => !nextKeys.has(segmentKey(s)));
      const added = next.filter((s) => !prevKeys.has(segmentKey(s)));
      sub.last = next;
      if (added.length > 0 || removed.length > 0) {
        sub.listener({ version: this.version, added, removed });
      }
    }
  }

  /** 供逐 tick 对照模型读取的原始状态快照。 */
  snapshot(): { online: ReadonlyMap<string, readonly Interval[]>; deps: ReadonlyMap<string, ReadonlySet<string>> } {
    return { online: this.online, deps: this.deps };
  }

  static covers = covers;
}
