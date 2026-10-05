import { covers } from "./intervals.js";
import { AvailabilityMonitor, Segment } from "./monitor.js";

/** 单服务在某一 tick 的证据：自身是否在线、各依赖是否可用、最终是否计入。 */
export interface ServiceEvidence {
  readonly online: boolean;
  readonly deps: Readonly<Record<string, boolean>>;
  readonly available: boolean;
}

/**
 * 逐 tick 参考模型：每个整数时刻独立计算。
 * 可用性 = 在线 且 所有（传递）依赖可用；用最大不动点收缩求解，
 * 循环依赖组件自然只有全成员在线时才计入。
 */
export class TickModel {
  constructor(private readonly monitor: AvailabilityMonitor) {}

  /** 某一 tick 的全来源证据：服务 -> 证据。 */
  evidence(t: number): Map<string, ServiceEvidence> {
    const { online, deps } = this.monitor.snapshot();
    const services = new Set<string>([...online.keys(), ...deps.keys()]);
    for (const targets of deps.values()) {
      for (const s of targets) services.add(s);
    }
    const isOnline = new Map<string, boolean>();
    for (const s of services) {
      isOnline.set(s, covers(online.get(s) ?? [], t));
    }
    // 最大不动点：从“全部在线者可用”开始，删去依赖不满足者直至稳定。
    const available = new Set<string>();
    for (const s of services) {
      if (isOnline.get(s)) available.add(s);
    }
    for (;;) {
      let changed = false;
      for (const s of [...available]) {
        for (const d of deps.get(s) ?? []) {
          if (!available.has(d)) {
            available.delete(s);
            changed = true;
            break;
          }
        }
      }
      if (!changed) break;
    }
    const out = new Map<string, ServiceEvidence>();
    for (const s of [...services].sort()) {
      const depEvidence: Record<string, boolean> = {};
      for (const d of deps.get(s) ?? []) {
        depEvidence[d] = available.has(d);
      }
      out.set(s, {
        online: isOnline.get(s)!,
        deps: depEvidence,
        available: available.has(s),
      });
    }
    return out;
  }

  /** 某一 tick 的可用服务集合（升序）。 */
  availableAt(t: number): string[] {
    const ev = this.evidence(t);
    return [...ev.entries()].filter(([, e]) => e.available).map(([s]) => s).sort();
  }

  /** 把 [tMin, tMax) 内每个 tick 的可用集合压缩成段（仅保留计数 >= k 的段）。 */
  segments(k: number, tMin: number, tMax: number): Segment[] {
    const out: Segment[] = [];
    for (let t = tMin; t < tMax; t++) {
      const services = this.availableAt(t);
      if (services.length < k) continue;
      const last = out[out.length - 1];
      if (last && last.end === t && last.services.join(",") === services.join(",")) {
        out[out.length - 1] = { start: last.start, end: t + 1, services };
      } else {
        out.push({ start: t, end: t + 1, services });
      }
    }
    return out;
  }
}
