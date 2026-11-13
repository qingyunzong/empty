import type { AuditApi, AuditEvent, AuditQuery, AuditPage } from "../src/audit-connector.ts";
import type { CursorPage, ProbeResult, SliceSource, TimeWindow } from "../src/planner.ts";

export interface FakeRecord {
  readonly id: string;
  readonly ts: number;
}

export function compareRecords(a: FakeRecord, b: FakeRecord): number {
  return a.ts - b.ts || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
}

/**
 * In-memory SliceSource mimicking a capped endpoint: any single request
 * returns at most `cap` rows and reports truncation beyond that.
 */
export function fakeSliceSource(
  records: readonly FakeRecord[],
  cap: number,
): SliceSource<FakeRecord, string> {
  const sorted = [...records].sort(compareRecords);
  const inWindow = (window: TimeWindow): FakeRecord[] =>
    sorted.filter((r) => r.ts >= window.startMs && r.ts < window.endMs);

  return {
    async probe(window: TimeWindow): Promise<ProbeResult> {
      const rows = inWindow(window);
      return { count: Math.min(rows.length, cap), truncated: rows.length > cap };
    },
    async fetchPage(window: TimeWindow, cursor: string | null): Promise<CursorPage<FakeRecord, string>> {
      let rows = inWindow(window);
      if (cursor !== null) {
        const anchor = sorted.find((r) => r.id === cursor);
        const anchorTs = anchor === undefined ? -1 : anchor.ts;
        rows = rows.filter((r) => r.ts > anchorTs || (r.ts === anchorTs && r.id > cursor));
      }
      const page = rows.slice(0, cap);
      const truncated = rows.length > page.length;
      return {
        records: page,
        truncated,
        nextCursor: truncated && page.length > 0 ? page[page.length - 1].id : null,
      };
    },
  };
}

/** In-memory capped audit endpoint honoring the (occurredAtMs, id) cursor. */
export class FakeAuditApi implements AuditApi {
  readonly #events: AuditEvent[];
  readonly cap: number;
  queryCount = 0;

  constructor(events: readonly AuditEvent[], cap: number) {
    this.#events = [...events].sort(compareAuditEvents);
    this.cap = cap;
  }

  async query(query: AuditQuery): Promise<AuditPage> {
    this.queryCount += 1;
    let rows = this.#events.filter(
      (e) => e.occurredAtMs >= query.startMs && e.occurredAtMs < query.endMs,
    );
    if (query.afterId !== null) {
      const anchor = this.#events.find((e) => e.id === query.afterId);
      const anchorTs = anchor === undefined ? -1 : anchor.occurredAtMs;
      rows = rows.filter(
        (e) =>
          e.occurredAtMs > anchorTs ||
          (e.occurredAtMs === anchorTs && e.id > (query.afterId as string)),
      );
    }
    const limit = Math.min(query.limit, this.cap);
    const events = rows.slice(0, limit);
    return { events, truncated: rows.length > events.length };
  }
}

function compareAuditEvents(a: AuditEvent, b: AuditEvent): number {
  return a.occurredAtMs - b.occurredAtMs || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
}

export function makeEvents(spec: readonly { ts: number; count: number; prefix: string }[]): AuditEvent[] {
  const events: AuditEvent[] = [];
  for (const { ts, count, prefix } of spec) {
    for (let i = 0; i < count; i += 1) {
      events.push({ id: `${prefix}-${String(i).padStart(4, "0")}`, occurredAtMs: ts });
    }
  }
  return events;
}
