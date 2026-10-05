/** A single event in a multi-source log. */
export interface LogEvent {
  /** Globally unique event id. */
  id: string;
  /** Id of the source (replica/node) that produced the event. */
  source: string;
  /** Per-source sequence number. */
  seq: number;
  /** Wall-clock timestamp. NOT required to be causally monotonic. */
  ts: number;
  /** Ids of predecessor (dependency) events. */
  deps: string[];
}

/**
 * Deterministic tie-break key for ready candidates:
 * smallest timestamp, then source id, then sequence number, then event id.
 */
export type EventKey = readonly [number, string, number, string];

export function keyOf(e: LogEvent): EventKey {
  return [e.ts, e.source, e.seq, e.id];
}

export function compareKeys(a: EventKey, b: EventKey): number {
  if (a[0] !== b[0]) return a[0] < b[0] ? -1 : 1;
  if (a[1] !== b[1]) return a[1] < b[1] ? -1 : 1;
  if (a[2] !== b[2]) return a[2] < b[2] ? -1 : 1;
  if (a[3] !== b[3]) return a[3] < b[3] ? -1 : 1;
  return 0;
}

/** Validate an untrusted value as a LogEvent; throws Error with context. */
export function validateEvent(raw: unknown, where: string): LogEvent {
  if (typeof raw !== "object" || raw === null) {
    throw new Error(`${where}: event must be an object`);
  }
  const r = raw as Record<string, unknown>;
  if (typeof r.id !== "string" || r.id.length === 0) {
    throw new Error(`${where}: event.id must be a non-empty string`);
  }
  if (typeof r.source !== "string" || r.source.length === 0) {
    throw new Error(`${where}: event.source must be a non-empty string`);
  }
  if (typeof r.seq !== "number" || !Number.isInteger(r.seq) || r.seq < 0) {
    throw new Error(`${where}: event.seq must be a non-negative integer`);
  }
  if (typeof r.ts !== "number" || !Number.isFinite(r.ts)) {
    throw new Error(`${where}: event.ts must be a finite number`);
  }
  if (!Array.isArray(r.deps) || r.deps.some((d) => typeof d !== "string")) {
    throw new Error(`${where}: event.deps must be an array of strings`);
  }
  const deps = [...new Set(r.deps as string[])].sort();
  return { id: r.id, source: r.source, seq: r.seq, ts: r.ts, deps };
}
