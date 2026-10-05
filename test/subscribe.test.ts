import test from "node:test";
import assert from "node:assert/strict";
import { Monitor, type Correction } from "../src/monitor.ts";
import { segmentKey, type Segment } from "../src/sweep.ts";

class Recorder {
  readonly corrections: Correction[] = [];
  private readonly live = new Map<string, Segment>();
  readonly listener = (c: Correction): void => {
    this.corrections.push({
      version: c.version,
      added: c.added.map((s) => ({ ...s, services: [...s.services] })),
      removed: c.removed.map((s) => ({ ...s, services: [...s.services] })),
    });
    for (const seg of c.removed) {
      assert.ok(
        this.live.delete(segmentKey(seg)),
        `removed segment must be live: ${segmentKey(seg)}`,
      );
    }
    for (const seg of c.added) {
      const key = segmentKey(seg);
      assert.ok(!this.live.has(key), `added segment must be new: ${key}`);
      this.live.set(key, seg);
    }
  };

  replay(): Segment[] {
    return [...this.live.values()].sort((a, b) => a.start - b.start || a.end - b.end);
  }
}

test("initial subscription delivers current snapshot bound to current version", () => {
  const monitor = new Monitor();
  monitor.addInterval("A", 0, 5);
  monitor.addInterval("B", 1, 4);
  const recorder = new Recorder();
  monitor.subscribe(2, recorder.listener);
  assert.equal(monitor.version, 2);
  assert.deepEqual(recorder.corrections, [
    { version: 2, added: [{ start: 1, end: 4, services: ["A", "B"] }], removed: [] },
  ]);
});

test("each mutation outside a transaction emits its own net diff with bumped version", () => {
  const monitor = new Monitor();
  const recorder = new Recorder();
  monitor.subscribe(1, recorder.listener);
  monitor.addInterval("A", 0, 4);
  monitor.addInterval("A", 4, 8);
  assert.deepEqual(
    recorder.corrections.map((c) => c.version),
    [1, 2],
  );
  assert.deepEqual(recorder.corrections[1], {
    version: 2,
    added: [{ start: 0, end: 8, services: ["A"] }],
    removed: [{ start: 0, end: 4, services: ["A"] }],
  });
  assert.deepEqual(recorder.replay(), monitor.getSegments(1));
});

test("transaction coalesces mutations into one net diff bound to one version", () => {
  const monitor = new Monitor();
  monitor.addInterval("A", 0, 10);
  monitor.addInterval("B", 0, 10);
  const recorder = new Recorder();
  monitor.subscribe(2, recorder.listener);
  recorder.corrections.length = 0;
  const before = monitor.version;
  monitor.transact(() => {
    monitor.addInterval("C", 2, 4);
    monitor.addInterval("C", 6, 8);
    monitor.addInterval("D", 3, 7);
  });
  assert.equal(monitor.version, before + 3);
  assert.equal(recorder.corrections.length, 1);
  const only = recorder.corrections[0]!;
  assert.equal(only.version, monitor.version);
  assert.deepEqual(only, {
    version: monitor.version,
    added: [
      { start: 0, end: 2, services: ["A", "B"] },
      { start: 2, end: 3, services: ["A", "B", "C"] },
      { start: 3, end: 4, services: ["A", "B", "C", "D"] },
      { start: 4, end: 6, services: ["A", "B", "D"] },
      { start: 6, end: 7, services: ["A", "B", "C", "D"] },
      { start: 7, end: 8, services: ["A", "B", "C"] },
      { start: 8, end: 10, services: ["A", "B"] },
    ],
    removed: [{ start: 0, end: 10, services: ["A", "B"] }],
  });
  assert.deepEqual(recorder.replay(), monitor.getSegments(2));
});

test("net diff cancels out changes that revert inside a transaction", () => {
  const monitor = new Monitor();
  monitor.addInterval("A", 0, 10);
  const recorder = new Recorder();
  monitor.subscribe(1, recorder.listener);
  recorder.corrections.length = 0;
  monitor.transact(() => {
    const id = monitor.addInterval("B", 2, 5);
    monitor.removeInterval(id);
  });
  assert.equal(recorder.corrections.length, 0);
  assert.deepEqual(recorder.replay(), monitor.getSegments(1));
});

test("dependency changes produce corrections for affected segments", () => {
  const monitor = new Monitor();
  monitor.addInterval("A", 0, 10);
  monitor.addInterval("B", 0, 10);
  const recorder = new Recorder();
  monitor.subscribe(1, recorder.listener);
  recorder.corrections.length = 0;
  monitor.addDependency("A", "ghost");
  assert.deepEqual(recorder.corrections, [
    {
      version: monitor.version,
      added: [{ start: 0, end: 10, services: ["B"] }],
      removed: [{ start: 0, end: 10, services: ["A", "B"] }],
    },
  ]);
  monitor.addInterval("ghost", 3, 6);
  assert.deepEqual(recorder.corrections[1], {
    version: monitor.version,
    added: [
      { start: 0, end: 3, services: ["B"] },
      { start: 3, end: 6, services: ["A", "B", "ghost"] },
      { start: 6, end: 10, services: ["B"] },
    ],
    removed: [{ start: 0, end: 10, services: ["B"] }],
  });
  monitor.removeDependency("A", "ghost");
  assert.deepEqual(recorder.replay(), monitor.getSegments(1));
});

test("replaying every correction from scratch reproduces the authoritative segments", () => {
  const monitor = new Monitor();
  const recorder = new Recorder();
  monitor.subscribe(2, recorder.listener);
  const ids: number[] = [];
  monitor.transact(() => {
    ids.push(monitor.addInterval("A", 0, 6));
    ids.push(monitor.addInterval("B", 3, 9));
    ids.push(monitor.addInterval("C", 5, 12));
  });
  monitor.addDependency("C", "A");
  monitor.transact(() => {
    monitor.removeInterval(ids[0]!);
    monitor.addInterval("D", 8, 14);
    monitor.addDependency("D", "C");
  });
  monitor.removeDependency("C", "A");
  monitor.removeInterval(ids[2]!);
  assert.deepEqual(recorder.replay(), monitor.getSegments(2));
  const versions = recorder.corrections.map((c) => c.version);
  assert.deepEqual(versions, [...versions].sort((a, b) => a - b));
  assert.ok(new Set(versions).size === versions.length, "one correction per version");
});

test("unsubscribe stops further corrections", () => {
  const monitor = new Monitor();
  const recorder = new Recorder();
  const unsubscribe = monitor.subscribe(1, recorder.listener);
  monitor.addInterval("A", 0, 5);
  unsubscribe();
  monitor.addInterval("B", 1, 2);
  assert.equal(recorder.corrections.length, 1);
});
