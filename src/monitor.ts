import {
  filterAtLeast,
  segmentKey,
  sweepOnlineSegments,
  type Interval,
  type Segment,
} from "./sweep.ts";
import { effectiveAvailable } from "./deps.ts";

export interface Correction {
  version: number;
  added: Segment[];
  removed: Segment[];
}

export type Listener = (correction: Correction) => void;

interface Subscriber {
  k: number;
  listener: Listener;
  lastSegments: Segment[];
}

export function diffSegments(before: readonly Segment[], after: readonly Segment[]): {
  added: Segment[];
  removed: Segment[];
} {
  const beforeKeys = new Set(before.map(segmentKey));
  const afterKeys = new Set(after.map(segmentKey));
  return {
    added: after.filter((seg) => !beforeKeys.has(segmentKey(seg))),
    removed: before.filter((seg) => !afterKeys.has(segmentKey(seg))),
  };
}

export class Monitor {
  private readonly intervals = new Map<string, Map<number, Interval>>();
  private readonly deps = new Map<string, Set<string>>();
  private readonly services = new Set<string>();
  private readonly subscribers = new Map<number, Subscriber>();
  private nextIntervalId = 1;
  private nextSubscriberId = 1;
  private transactionDepth = 0;
  private dirty = false;
  private versionValue = 0;

  get version(): number {
    return this.versionValue;
  }

  addService(name: string): void {
    this.services.add(name);
  }

  addInterval(service: string, start: number, end: number): number {
    if (!(start < end)) {
      throw new RangeError(`invalid interval [${start}, ${end})`);
    }
    this.services.add(service);
    let byId = this.intervals.get(service);
    if (byId === undefined) {
      byId = new Map();
      this.intervals.set(service, byId);
    }
    const id = this.nextIntervalId++;
    byId.set(id, { start, end });
    this.commit();
    return id;
  }

  removeInterval(id: number): boolean {
    for (const byId of this.intervals.values()) {
      if (byId.delete(id)) {
        this.commit();
        return true;
      }
    }
    return false;
  }

  addDependency(service: string, dependsOn: string): void {
    this.services.add(service);
    this.services.add(dependsOn);
    let targets = this.deps.get(service);
    if (targets === undefined) {
      targets = new Set();
      this.deps.set(service, targets);
    }
    if (!targets.has(dependsOn)) {
      targets.add(dependsOn);
      this.commit();
    }
  }

  removeDependency(service: string, dependsOn: string): boolean {
    const targets = this.deps.get(service);
    if (targets !== undefined && targets.delete(dependsOn)) {
      this.commit();
      return true;
    }
    return false;
  }

  snapshotIntervals(): Map<string, Map<number, Interval>> {
    const copy = new Map<string, Map<number, Interval>>();
    for (const [service, byId] of this.intervals) {
      copy.set(service, new Map([...byId.entries()].map(([id, iv]) => [id, { ...iv }])));
    }
    return copy;
  }

  snapshotDeps(): Map<string, Set<string>> {
    const copy = new Map<string, Set<string>>();
    for (const [service, targets] of this.deps) {
      copy.set(service, new Set(targets));
    }
    return copy;
  }

  knownServices(): string[] {
    return [...this.services].sort();
  }

  onlineSegments(): Segment[] {
    return sweepOnlineSegments(this.intervals);
  }

  effectiveSegments(): Segment[] {
    const segments: Segment[] = [];
    for (const seg of this.onlineSegments()) {
      const available = effectiveAvailable(new Set(seg.services), this.deps, this.services);
      const services = [...available].sort();
      if (services.length === 0) continue;
      const last = segments[segments.length - 1];
      if (
        last !== undefined &&
        last.end === seg.start &&
        last.services.length === services.length &&
        last.services.every((s, i) => s === services[i])
      ) {
        last.end = seg.end;
      } else {
        segments.push({ start: seg.start, end: seg.end, services });
      }
    }
    return segments;
  }

  getSegments(k: number): Segment[] {
    return filterAtLeast(this.effectiveSegments(), k);
  }

  subscribe(k: number, listener: Listener): () => void {
    if (!Number.isInteger(k) || k < 1) {
      throw new RangeError(`k must be a positive integer, got ${k}`);
    }
    const id = this.nextSubscriberId++;
    const current = this.getSegments(k);
    this.subscribers.set(id, { k, listener, lastSegments: current });
    if (current.length > 0) {
      listener({ version: this.versionValue, added: current, removed: [] });
    }
    return () => {
      this.subscribers.delete(id);
    };
  }

  transact<T>(fn: () => T): T {
    this.transactionDepth += 1;
    try {
      return fn();
    } finally {
      this.transactionDepth -= 1;
      if (this.transactionDepth === 0 && this.dirty) {
        this.dirty = false;
        this.flush();
      }
    }
  }

  private commit(): void {
    this.versionValue += 1;
    if (this.transactionDepth > 0) {
      this.dirty = true;
    } else {
      this.flush();
    }
  }

  private flush(): void {
    for (const sub of this.subscribers.values()) {
      const current = this.getSegments(sub.k);
      const { added, removed } = diffSegments(sub.lastSegments, current);
      if (added.length > 0 || removed.length > 0) {
        sub.listener({ version: this.versionValue, added, removed });
        sub.lastSegments = current;
      }
    }
  }
}
