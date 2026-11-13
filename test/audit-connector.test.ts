import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  createAuditSliceSource,
  createAuditSync,
  type AuditApi,
  type AuditEvent,
} from "../src/audit-connector.ts";
import { MemoryCheckpointStore, windowKey } from "../src/checkpoint.ts";
import { SliceOverflowError, type PlannedSlice } from "../src/planner.ts";
import type { SliceSink } from "../src/sync.ts";
import { FakeAuditApi, makeEvents } from "./fakes.ts";

class CollectingAuditSink implements SliceSink<AuditEvent> {
  readonly slices = new Map<string, AuditEvent[]>();

  async publish(slice: PlannedSlice<AuditEvent>, records: readonly AuditEvent[]): Promise<void> {
    this.slices.set(windowKey(slice.window), [...records]);
  }

  allEvents(): AuditEvent[] {
    return [...this.slices.values()].flat();
  }
}

const ROOT = { startMs: 1_000_000, endMs: 1_008_192 };

describe("audit connector", () => {
  it("plugs the capped audit endpoint into the planner and syncs end to end", async () => {
    const events = makeEvents([
      { ts: 1_000_100, count: 4, prefix: "a" },
      { ts: 1_002_000, count: 40, prefix: "b" },
      { ts: 1_005_000, count: 7, prefix: "c" },
    ]);
    const api = new FakeAuditApi(events, 10);
    const store = new MemoryCheckpointStore();
    const sink = new CollectingAuditSink();

    const sync = createAuditSync(api, { store, sink, pageSize: 10 });
    const report = await sync.run(ROOT);

    assert.equal(report.totalRecords, 51);
    assert.equal(report.skipped.length, 0);
    const published = sink.allEvents();
    assert.equal(published.length, 51);
    assert.equal(new Set(published.map((e) => e.id)).size, 51);

    const resumed = await sync.run(ROOT);
    assert.equal(resumed.published.length, 0);
    assert.equal(resumed.skipped.length, report.published.length);
  });

  it("continues same-timestamp events with the stable id cursor", async () => {
    const events = makeEvents([{ ts: 1_000_001, count: 95, prefix: "same" }]);
    const api = new FakeAuditApi(events, 10);
    const sink = new CollectingAuditSink();
    const sync = createAuditSync(api, {
      store: new MemoryCheckpointStore(),
      sink,
      pageSize: 10,
    });

    const report = await sync.run(ROOT);
    assert.equal(report.totalRecords, 95);
    const ids = sink.allEvents().map((e) => e.id);
    assert.equal(new Set(ids).size, 95);
    const burstSlice = sink.slices.get(windowKey({ startMs: 1_000_001, endMs: 1_000_002 }));
    assert.equal(burstSlice?.length, 95);
  });

  it("fails explicitly when the endpoint stays truncated at a minimal window", async () => {
    const brokenApi: AuditApi = {
      async query() {
        return { events: [], truncated: true };
      },
    };
    const sink = new CollectingAuditSink();
    const sync = createAuditSync(brokenApi, {
      store: new MemoryCheckpointStore(),
      sink,
      pageSize: 10,
    });
    await assert.rejects(sync.run({ startMs: 0, endMs: 4 }), SliceOverflowError);
  });

  it("treats a full page without a truncated flag as capped", async () => {
    const events = makeEvents([{ ts: 5, count: 3, prefix: "p" }]);
    const flaglessApi: AuditApi = {
      async query(query) {
        const rows = events.filter(
          (e) => e.occurredAtMs >= query.startMs && e.occurredAtMs < query.endMs,
        );
        return { events: rows.slice(0, query.limit), truncated: false };
      },
    };
    const source = createAuditSliceSource(flaglessApi, { pageSize: 3 });
    const probe = await source.probe({ startMs: 0, endMs: 10 });
    assert.equal(probe.truncated, true, "pageSize-length page must be treated as possibly capped");
  });
});
