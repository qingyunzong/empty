export interface Interval {
  start: number;
  end: number;
}

export interface Segment {
  start: number;
  end: number;
  services: string[];
}

export function segmentKey(seg: Segment): string {
  return `${seg.start}|${seg.end}|${seg.services.join(",")}`;
}

export function sameServices(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

interface PointEvents {
  add: string[];
  remove: string[];
}

export function sweepOnlineSegments(
  intervals: ReadonlyMap<string, ReadonlyMap<number, Interval>>,
): Segment[] {
  const events = new Map<number, PointEvents>();
  const eventAt = (point: number): PointEvents => {
    let ev = events.get(point);
    if (ev === undefined) {
      ev = { add: [], remove: [] };
      events.set(point, ev);
    }
    return ev;
  };
  for (const [service, byId] of intervals) {
    for (const iv of byId.values()) {
      if (!(iv.start < iv.end)) {
        throw new RangeError(`invalid interval [${iv.start}, ${iv.end}) for ${service}`);
      }
      eventAt(iv.start).add.push(service);
      eventAt(iv.end).remove.push(service);
    }
  }
  const points = [...events.keys()].sort((a, b) => a - b);
  const refCount = new Map<string, number>();
  const segments: Segment[] = [];
  let prev: number | null = null;
  const emit = (end: number) => {
    if (prev === null || end <= prev || refCount.size === 0) return;
    const services = [...refCount.keys()].sort();
    const last = segments[segments.length - 1];
    if (last !== undefined && last.end === prev && sameServices(last.services, services)) {
      last.end = end;
    } else {
      segments.push({ start: prev, end, services });
    }
  };
  for (const point of points) {
    emit(point);
    const ev = events.get(point);
    if (ev !== undefined) {
      for (const service of ev.remove) {
        const count = refCount.get(service);
        if (count === undefined || count <= 1) {
          refCount.delete(service);
        } else {
          refCount.set(service, count - 1);
        }
      }
      for (const service of ev.add) {
        refCount.set(service, (refCount.get(service) ?? 0) + 1);
      }
    }
    prev = point;
  }
  return segments;
}

export function filterAtLeast(segments: readonly Segment[], k: number): Segment[] {
  if (!Number.isInteger(k) || k < 1) {
    throw new RangeError(`k must be a positive integer, got ${k}`);
  }
  return segments
    .filter((seg) => seg.services.length >= k)
    .map((seg) => ({ start: seg.start, end: seg.end, services: [...seg.services] }));
}
