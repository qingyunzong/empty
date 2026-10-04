import test from "node:test";
import assert from "node:assert/strict";
import { mapLimit, MapLimitError, deferred } from "../src/index.js";
import type { Deferred } from "../src/index.js";

const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

function makeGate(count: number): { gates: Array<Deferred<string>>; started: number[] } {
  const gates: Array<Deferred<string>> = [];
  const started: number[] = [];
  for (let i = 0; i < count; i += 1) {
    gates.push(deferred<string>());
    started.push(-1);
  }
  return { gates, started };
}

test("resolves with values in input order despite out-of-order completion", async () => {
  const { gates } = makeGate(4);
  const done = mapLimit(["a", "b", "c", "d"], 2, (item, index) => {
    const gate = gates[index];
    assert.ok(gate);
    return gate.promise.then(() => `${item}${index}`);
  });
  await tick();
  gates[1]?.resolve("ignored");
  await tick();
  gates[0]?.resolve("ignored");
  await tick();
  gates[3]?.resolve("ignored");
  await tick();
  gates[2]?.resolve("ignored");
  assert.deepEqual(await done, ["a0", "b1", "c2", "d3"]);
});

test("never exceeds the concurrency limit", async () => {
  let active = 0;
  let maxActive = 0;
  const items = Array.from({ length: 20 }, (_, i) => i);
  const values = await mapLimit(items, 3, async (n) => {
    active += 1;
    maxActive = Math.max(maxActive, active);
    await tick();
    active -= 1;
    return n * 2;
  });
  assert.deepEqual(values, items.map((n) => n * 2));
  assert.equal(maxActive, 3);
});

test("stops launching later items after a failure; started items still settle", async () => {
  const { gates, started } = makeGate(6);
  const settled: number[] = [];
  const boom = new Error("boom-1");
  const done = mapLimit([0, 1, 2, 3, 4, 5], 2, (_item, index) => {
    started[index] = index;
    const gate = gates[index];
    assert.ok(gate);
    return gate.promise.then(
      () => {
        settled.push(index);
        return index * 10;
      },
      (reason: unknown) => {
        settled.push(index);
        throw reason;
      },
    );
  });
  await tick();
  gates[1]?.reject(boom);
  await tick();
  await tick();
  assert.deepEqual(started, [0, 1, -1, -1, -1, -1], "items after the failure must not start");
  gates[0]?.resolve("ok");
  const error = await done.then(
    () => assert.fail("should reject"),
    (err: unknown) => err,
  );
  assert.ok(error instanceof MapLimitError);
  assert.equal(error.index, 1);
  assert.equal(error.cause, boom);
  assert.deepEqual(error.values, [0], "successful prefix before the failure is preserved");
  assert.deepEqual(settled.sort(), [0, 1], "in-flight items settled before rejection");
});

test("picks the smallest failing index when failures happen out of order", async () => {
  const { gates } = makeGate(3);
  const lateBoom = new Error("fails-first-in-time");
  const earlyBoom = new Error("smallest-index");
  const done = mapLimit(["x", "y", "z"], 3, (_item, index) => {
    const gate = gates[index];
    assert.ok(gate);
    return gate.promise.then(() => index);
  });
  await tick();
  gates[2]?.reject(lateBoom);
  await tick();
  gates[1]?.reject(earlyBoom);
  await tick();
  gates[0]?.resolve("ok");
  const error = await done.then(
    () => assert.fail("should reject"),
    (err: unknown) => err,
  );
  assert.ok(error instanceof MapLimitError);
  assert.equal(error.index, 1, "earliest failing index wins, not the first in time");
  assert.equal(error.cause, earlyBoom);
  assert.deepEqual(error.values, [0]);
});

test("caller abort cancels unstarted items and lets started ones settle", async () => {
  const controller = new AbortController();
  const { gates, started } = makeGate(5);
  const done = mapLimit([0, 1, 2, 3, 4], 2, (_item, index) => {
    started[index] = index;
    const gate = gates[index];
    assert.ok(gate);
    return gate.promise.then(() => index);
  }, { signal: controller.signal });
  await tick();
  controller.abort();
  await tick();
  assert.deepEqual(started, [0, 1, -1, -1, -1], "unstarted items are cancelled");
  let settled = false;
  void done.catch(() => {
    settled = true;
  });
  await tick();
  assert.equal(settled, false, "waits for in-flight items before rejecting");
  gates[0]?.resolve("ok");
  gates[1]?.resolve("ok");
  const error = await done.then(
    () => assert.fail("should reject"),
    (err: unknown) => err,
  );
  assert.ok(error instanceof DOMException);
  assert.equal((error as DOMException).name, "AbortError");
});

test("abort before start launches nothing", async () => {
  const controller = new AbortController();
  controller.abort();
  let calls = 0;
  const error = await mapLimit([1, 2, 3], 2, async (n) => {
    calls += 1;
    return n;
  }, { signal: controller.signal }).then(
    () => assert.fail("should reject"),
    (err: unknown) => err,
  );
  assert.equal((error as DOMException).name, "AbortError");
  assert.equal(calls, 0);
});

test("rejects invalid concurrency", async () => {
  await assert.rejects(() => mapLimit([1], 0, async (n) => n), RangeError);
  await assert.rejects(() => mapLimit([1], 1.5, async (n) => n), RangeError);
});

test("handles an empty input", async () => {
  assert.deepEqual(await mapLimit([], 4, async (n: number) => n), []);
});

test("surfaces synchronous mapper throws as failures", async () => {
  const boom = new Error("sync");
  const error = await mapLimit([1, 2, 3], 1, (n) => {
    if (n === 2) {
      throw boom;
    }
    return n;
  }).then(
    () => assert.fail("should reject"),
    (err: unknown) => err,
  );
  assert.ok(error instanceof MapLimitError);
  assert.equal(error.index, 1);
  assert.equal(error.cause, boom);
  assert.deepEqual(error.values, [1]);
});
