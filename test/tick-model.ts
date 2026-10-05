import assert from "node:assert/strict";
import { effectiveAvailable } from "../src/deps.ts";
import type { Interval, Segment } from "../src/sweep.ts";

export interface TickRecord {
  tick: number;
  online: string[];
  available: string[];
  evidence: Map<string, number[]>;
}

export function tickScan(
  intervals: ReadonlyMap<string, ReadonlyMap<number, Interval>>,
  deps: ReadonlyMap<string, ReadonlySet<string>>,
  services: readonly string[],
  from: number,
  to: number,
): TickRecord[] {
  const records: TickRecord[] = [];
  for (let tick = from; tick < to; tick++) {
    const evidence = new Map<string, number[]>();
    for (const [service, byId] of intervals) {
      for (const [id, iv] of byId) {
        if (iv.start <= tick && tick < iv.end) {
          const list = evidence.get(service);
          if (list === undefined) {
            evidence.set(service, [id]);
          } else {
            list.push(id);
          }
        }
      }
    }
    const online = [...evidence.keys()].sort();
    const available = [...effectiveAvailable(new Set(online), deps, services)].sort();
    records.push({ tick, online, available, evidence });
  }
  return records;
}

export function tickSegments(records: readonly TickRecord[], k: number): Segment[] {
  const segments: Segment[] = [];
  for (const record of records) {
    if (record.available.length < k) continue;
    const last = segments[segments.length - 1];
    if (
      last !== undefined &&
      last.end === record.tick &&
      last.services.length === record.available.length &&
      last.services.every((s, i) => s === record.available[i])
    ) {
      last.end = record.tick + 1;
    } else {
      segments.push({
        start: record.tick,
        end: record.tick + 1,
        services: [...record.available],
      });
    }
  }
  return segments;
}

export function assertFullSourceEvidence(records: readonly TickRecord[]): void {
  for (const record of records) {
    for (const service of record.online) {
      const ids = record.evidence.get(service) ?? [];
      assert.ok(
        ids.length > 0,
        `tick ${record.tick}: online service ${service} lacks source interval evidence`,
      );
    }
    for (const service of record.available) {
      const ids = record.evidence.get(service) ?? [];
      assert.ok(
        ids.length > 0,
        `tick ${record.tick}: available service ${service} lacks source interval evidence`,
      );
    }
    for (const [service, ids] of record.evidence) {
      assert.ok(
        record.online.includes(service),
        `tick ${record.tick}: evidence for ${service} but not online`,
      );
      assert.deepEqual([...ids].sort((a, b) => a - b), ids, `tick ${record.tick}: ids stable`);
    }
  }
}

export function assertSweepMatchesTicks(
  actual: readonly Segment[],
  records: readonly TickRecord[],
  k: number,
): void {
  const expected = tickSegments(records, k);
  assert.deepEqual(
    actual.map((s) => ({ start: s.start, end: s.end, services: s.services })),
    expected.map((s) => ({ start: s.start, end: s.end, services: s.services })),
    `sweep segments must equal per-tick model segments for k=${k}`,
  );
  assertFullSourceEvidence(records);
}
