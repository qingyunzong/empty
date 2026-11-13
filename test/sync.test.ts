import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import { FileCheckpointStore, MemoryCheckpointStore, windowKey } from "../src/checkpoint.ts";
import type { PlannedSlice } from "../src/planner.ts";
import { TimeSliceSync, type SliceSink } from "../src/sync.ts";
import { fakeSliceSource, type FakeRecord } from "./fakes.ts";

class CollectingSink implements SliceSink<FakeRecord> {
  readonly published = new Map<string, FakeRecord[]>();
  failAfter = Infinity;
  #calls = 0;

  async publish(slice: PlannedSlice<FakeRecord>, records: readonly FakeRecord[]): Promise<void> {
    this.#calls += 1;
    if (this.#calls > this.failAfter) {
      throw new Error("sink boom");
    }
    this.published.set(windowKey(slice.window), [...records]);
  }
}

const recordKey = (record: FakeRecord): string => record.id;

function makeDataset(): FakeRecord[] {
  const records: FakeRecord[] = [];
  for (let i = 0; i < 200; i += 1) {
    records.push({ id: `s-${String(i).padStart(4, "0")}`, ts: i * 10 });
  }
  for (let i = 0; i < 30; i += 1) {
    records.push({ id: `burst-${String(i).padStart(3, "0")}`, ts: 5000 });
  }
  return records;
}

const ROOT = { startMs: 0, endMs: 8192 };

function makeSync(store: MemoryCheckpointStore | FileCheckpointStore, sink: CollectingSink) {
  return new TimeSliceSync<FakeRecord, string>({
    source: fakeSliceSource(makeDataset(), 10),
    store,
    sink,
    recordKey,
    now: () => new Date("2026-11-14T00:00:00.000Z"),
  });
}

describe("TimeSliceSync", () => {
  it("publishes every record exactly once and checkpoints a summary per slice", async () => {
    const store = new MemoryCheckpointStore();
    const sink = new CollectingSink();
    const report = await makeSync(store, sink).run(ROOT);

    const allPublished = [...sink.published.values()].flat();
    assert.equal(allPublished.length, 230);
    assert.equal(new Set(allPublished.map((r) => r.id)).size, 230);
    assert.equal(report.totalRecords, 230);
    assert.equal(report.skipped.length, 0);

    const summaries = await store.all();
    assert.equal(summaries.length, report.published.length);
    assert.equal(
      summaries.reduce((sum, s) => sum + s.recordCount, 0),
      230,
    );
    for (const summary of summaries) {
      assert.match(summary.digest, /^[0-9a-f]{64}$/);
      assert.equal(summary.completedAt, "2026-11-14T00:00:00.000Z");
    }
  });

  it("resumes without re-publishing slices that already have summaries", async () => {
    const store = new MemoryCheckpointStore();
    const firstSink = new CollectingSink();
    const first = await makeSync(store, firstSink).run(ROOT);
    assert.ok(first.published.length > 0);

    const secondSink = new CollectingSink();
    const second = await makeSync(store, secondSink).run(ROOT);
    assert.equal(second.published.length, 0);
    assert.equal(second.skipped.length, first.published.length);
    assert.equal(secondSink.published.size, 0);
    assert.equal(second.totalRecords, 230);
  });

  it("recovers from a mid-run crash without duplicating publishes", async () => {
    const store = new MemoryCheckpointStore();
    const crashingSink = new CollectingSink();
    crashingSink.failAfter = 3;
    await assert.rejects(makeSync(store, crashingSink).run(ROOT), /sink boom/);
    assert.equal(crashingSink.published.size, 3);
    assert.equal((await store.all()).length, 3);

    const resumeSink = new CollectingSink();
    const report = await makeSync(store, resumeSink).run(ROOT);
    assert.equal(report.skipped.length, 3);
    for (const key of crashingSink.published.keys()) {
      assert.ok(!resumeSink.published.has(key), `slice ${key} must not be re-published`);
    }
    const total = [...crashingSink.published.values(), ...resumeSink.published.values()].flat();
    assert.equal(new Set(total.map((r) => r.id)).size, 230);
  });

  it("persists summaries in a file store across process restarts", async () => {
    const dir = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "slice-checkpoints-"));
    const path = join(dir, "checkpoints.json");

    const firstSink = new CollectingSink();
    const first = await makeSync(new FileCheckpointStore(path), firstSink).run(ROOT);
    const onDisk = JSON.parse(readFileSync(path, "utf8")) as unknown[];
    assert.equal(onDisk.length, first.published.length);

    const resumeSink = new CollectingSink();
    const second = await makeSync(new FileCheckpointStore(path), resumeSink).run(ROOT);
    assert.equal(second.published.length, 0);
    assert.equal(second.skipped.length, first.published.length);
    assert.equal(resumeSink.published.size, 0);
  });
});
