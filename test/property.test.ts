import test from "node:test";
import assert from "node:assert/strict";
import { Change, SyncEngine } from "../src/index";
import {
  engineState,
  feed,
  feedComplete,
  makeStream,
  mulberry32,
  ReferenceModel,
  shuffle,
} from "./helpers";

test("shuffled application converges to the sequential reference (30 seeds)", () => {
  for (let seed = 1; seed <= 30; seed++) {
    const rand = mulberry32(seed);
    const stream = makeStream(6, 12, rand);
    const shuffled = shuffle(stream, rand);

    const reference = new ReferenceModel<string>();
    reference.applyOrdered(stream);

    const engine = new SyncEngine<string>({ maxBuffered: 16 });
    feedComplete(engine, shuffled);

    assert.equal(engine.bufferedCount, 0, `seed ${seed}: buffer not drained`);
    assert.deepEqual(engineState(engine), reference.sortedState(), `seed ${seed}: state diverged`);
    for (const key of reference.keys()) {
      assert.equal(engine.cursor(key), reference.cursorOf(key), `seed ${seed}: cursor ${key}`);
    }
  }
});

test("snapshot/restore mid-stream preserves pending and still converges", () => {
  for (let seed = 100; seed < 115; seed++) {
    const rand = mulberry32(seed);
    const stream = makeStream(5, 10, rand);
    const shuffled = shuffle(stream, rand);
    const midpoint = Math.floor(shuffled.length / 2);

    const reference = new ReferenceModel<string>();
    reference.applyOrdered(stream);

    // Feed the first half into a live engine; some changes may be deferred
    // (backpressure) because their predecessors only arrive in the second half.
    const live = new SyncEngine<string>({ maxBuffered: 8 });
    const deferred = feed(live, shuffled.slice(0, midpoint));
    const pendingAtSnapshot = live.bufferedCount;

    const restored = SyncEngine.restore<string>(
      JSON.parse(JSON.stringify(live.snapshot())),
    );
    assert.equal(restored.bufferedCount, pendingAtSnapshot, `seed ${seed}: pending lost`);

    // The restored engine resumes exactly where the live one stopped.
    feedComplete(restored, [...deferred, ...shuffled.slice(midpoint)]);

    assert.equal(restored.bufferedCount, 0, `seed ${seed}: buffer not drained`);
    assert.deepEqual(engineState(restored), reference.sortedState(), `seed ${seed}: state diverged`);
    for (const key of reference.keys()) {
      assert.equal(restored.cursor(key), reference.cursorOf(key), `seed ${seed}: cursor ${key}`);
    }
  }
});

test("snapshots regularly hold pending changes (guard against vacuous test)", () => {
  let sawPending = 0;
  for (let seed = 100; seed < 115; seed++) {
    const rand = mulberry32(seed);
    const shuffled = shuffle(makeStream(5, 10, rand), rand);
    const engine = new SyncEngine<string>({ maxBuffered: 8 });
    feed(engine, shuffled.slice(0, Math.floor(shuffled.length / 2)));
    if (engine.bufferedCount > 0) sawPending++;
  }
  assert.ok(sawPending > 0, "no snapshot ever had pending changes");
});

test("tight budget (maxBuffered=1) still converges under backpressure retries", () => {
  for (let seed = 7; seed < 12; seed++) {
    const rand = mulberry32(seed);
    const stream = makeStream(3, 8, rand);
    const shuffled = shuffle(stream, rand);

    const reference = new ReferenceModel<string>();
    reference.applyOrdered(stream);

    const engine = new SyncEngine<string>({ maxBuffered: 1 });
    feedComplete(engine, shuffled);

    assert.equal(engine.bufferedCount, 0);
    assert.deepEqual(engineState(engine), reference.sortedState());
  }
});

test("every shuffled stream exercises deletes that advance cursors", () => {
  const rand = mulberry32(42);
  const stream = makeStream(6, 12, rand);
  const deletes = stream.filter((c: Change<string>) => c.op === "delete").length;
  assert.ok(deletes > 0, "generator produced no deletes");

  const reference = new ReferenceModel<string>();
  reference.applyOrdered(stream);
  const engine = new SyncEngine<string>({ maxBuffered: 16 });
  feedComplete(engine, shuffle(stream, rand));

  // Tombstone keys (deleted at end of chain) must still have full cursors.
  const liveKeys = new Set(reference.sortedState().map(([k]) => k));
  for (let k = 0; k < 6; k++) {
    const key = `obj-${k}`;
    assert.equal(engine.cursor(key), 12);
    assert.equal(engine.get(key) === undefined, !liveKeys.has(key));
  }
});
