import { test } from "node:test";
import assert from "node:assert/strict";
import { VirtualClock } from "../src/clock.js";

test("same-tick events fire in scheduling order", () => {
  const clock = new VirtualClock();
  const fired: string[] = [];
  clock.setTimeout(() => fired.push("a"), 5);
  clock.setTimeout(() => fired.push("b"), 5);
  clock.setTimeout(() => fired.push("c"), 3);
  clock.advance(10);
  assert.deepEqual(fired, ["c", "a", "b"]);
});

test("event scheduled during a same-tick callback runs after queued peers", () => {
  const clock = new VirtualClock();
  const fired: string[] = [];
  clock.setTimeout(() => {
    fired.push("first");
    clock.setTimeout(() => fired.push("nested"), 0);
  }, 5);
  clock.setTimeout(() => fired.push("second"), 5);
  clock.advance(5);
  assert.deepEqual(fired, ["first", "second", "nested"]);
});

test("clearTimeout prevents firing", () => {
  const clock = new VirtualClock();
  const fired: string[] = [];
  const id = clock.setTimeout(() => fired.push("x"), 5);
  clock.clearTimeout(id);
  clock.advance(10);
  assert.deepEqual(fired, []);
  assert.equal(clock.pendingCount, 0);
});
