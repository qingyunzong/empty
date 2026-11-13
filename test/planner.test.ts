import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  SliceOverflowError,
  UnstableCursorError,
  planSlices,
  type PlannedSlice,
  type SliceSource,
} from "../src/planner.ts";
import { fakeSliceSource, type FakeRecord } from "./fakes.ts";

function spreadRecords(count: number, startTs: number): FakeRecord[] {
  return Array.from({ length: count }, (_, i) => ({
    id: `r-${String(i).padStart(6, "0")}`,
    ts: startTs + i,
  }));
}

function assertTiling(slices: readonly PlannedSlice<FakeRecord>[], startMs: number, endMs: number): void {
  assert.ok(slices.length > 0);
  assert.equal(slices[0].window.startMs, startMs);
  assert.equal(slices[slices.length - 1].window.endMs, endMs);
  for (let i = 1; i < slices.length; i += 1) {
    assert.equal(slices[i].window.startMs, slices[i - 1].window.endMs, "slices must tile contiguously");
  }
}

describe("planSlices", () => {
  it("returns a single slice when the window is under the cap", async () => {
    const source = fakeSliceSource(spreadRecords(5, 1000), 10);
    const slices = await planSlices(source, { startMs: 0, endMs: 2000 });
    assert.deepEqual(slices, [
      { kind: "window", window: { startMs: 0, endMs: 2000 }, expectedCount: 5 },
    ]);
  });

  it("bisects overflowing windows into contiguous half-open sub-windows", async () => {
    const source = fakeSliceSource(spreadRecords(1000, 0), 5);
    const slices = await planSlices(source, { startMs: 0, endMs: 1024 });
    assertTiling(slices, 0, 1024);
    for (const slice of slices) {
      assert.equal(slice.kind, "window");
      if (slice.kind === "window") {
        assert.ok(slice.expectedCount <= 5, `leaf ${slice.window.startMs} exceeds cap`);
      }
    }
    const total = slices.reduce(
      (sum, slice) => sum + (slice.kind === "window" ? slice.expectedCount : slice.records.length),
      0,
    );
    assert.equal(total, 1000);
  });

  it("drains a same-timestamp overflow through the stable secondary cursor", async () => {
    const cluster: FakeRecord[] = Array.from({ length: 25 }, (_, i) => ({
      id: `c-${String(i).padStart(3, "0")}`,
      ts: 100,
    }));
    const source = fakeSliceSource(cluster, 10);
    const slices = await planSlices(source, { startMs: 96, endMs: 112 });
    assertTiling(slices, 96, 112);
    const materialized = slices.filter((s) => s.kind === "materialized");
    assert.equal(materialized.length, 1);
    const slice = materialized[0];
    assert.deepEqual(slice.window, { startMs: 100, endMs: 101 });
    if (slice.kind === "materialized") {
      assert.equal(slice.records.length, 25);
      assert.deepEqual(
        slice.records.map((r) => r.id),
        cluster.map((r) => r.id),
      );
    }
  });

  it("fails explicitly when a minimal window still overflows and the cursor is exhausted", async () => {
    const source: SliceSource<FakeRecord, string> = {
      async probe() {
        return { count: 10, truncated: true };
      },
      async fetchPage() {
        return { records: [], nextCursor: null, truncated: true };
      },
    };
    await assert.rejects(planSlices(source, { startMs: 0, endMs: 1 }), SliceOverflowError);
  });

  it("fails explicitly when the secondary cursor does not advance", async () => {
    const record: FakeRecord = { id: "x", ts: 0 };
    const source: SliceSource<FakeRecord, string> = {
      async probe() {
        return { count: 1, truncated: true };
      },
      async fetchPage() {
        return { records: [record], nextCursor: "x", truncated: true };
      },
    };
    await assert.rejects(planSlices(source, { startMs: 0, endMs: 1 }), UnstableCursorError);
  });

  it("rejects invalid windows", async () => {
    const source = fakeSliceSource([], 10);
    await assert.rejects(planSlices(source, { startMs: 10, endMs: 10 }), RangeError);
    await assert.rejects(planSlices(source, { startMs: 10, endMs: 5 }), RangeError);
    await assert.rejects(planSlices(source, { startMs: -1, endMs: 5 }), RangeError);
  });
});
