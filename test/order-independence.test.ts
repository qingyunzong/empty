import test from "node:test";
import * as assert from "node:assert/strict";
import { runProperty, PropertyResult } from "../src/property";
import { integer, arrayOf } from "../src/gen";

const CONFIG = { seed: 20261006, runs: 200 };

const propA = () =>
  runProperty("order/prop-a", integer(0, 500), (n) => n < 250, CONFIG);
const propB = () =>
  runProperty(
    "order/prop-b",
    arrayOf(integer(0, 100), { maxLength: 10 }),
    (xs) => !xs.includes(77),
    CONFIG
  );
const propC = () =>
  runProperty("order/prop-c", integer(-100, 100), (n) => n === 0 || n < -50, CONFIG);

function summarize(r: PropertyResult) {
  return {
    ok: r.ok,
    runs: r.runs,
    counterexample: r.record?.counterexample,
    runSeed: r.record?.runSeed,
    runIndex: r.record?.runIndex,
    shrinkPath: r.record?.shrinkPath,
    traceLength: r.record?.shrinkTrace.length,
  };
}

test("results are identical regardless of execution order", () => {
  // Order 1: A, B, C
  const a1 = summarize(propA());
  const b1 = summarize(propB());
  const c1 = summarize(propC());

  // Order 2: C, A, B (reverse-ish interleaving)
  const c2 = summarize(propC());
  const a2 = summarize(propA());
  const b2 = summarize(propB());

  assert.deepEqual(a1, a2);
  assert.deepEqual(b1, b2);
  assert.deepEqual(c1, c2);
});

test("re-running the same property in one process is deterministic", () => {
  const first = summarize(propA());
  const second = summarize(propA());
  assert.deepEqual(first, second);
});

test("each property has an independent stream: renaming changes the stream", () => {
  const r1 = runProperty("independent/one", integer(0, 1000), () => true, CONFIG);
  const r2 = runProperty("independent/two", integer(0, 1000), () => true, CONFIG);
  assert.ok(r1.ok && r2.ok);
  // Different names -> different property seeds -> independent streams.
  const s1 = runProperty("independent/one", integer(0, 1000), (n) => n < 500, CONFIG);
  const s2 = runProperty("independent/two", integer(0, 1000), (n) => n < 500, CONFIG);
  assert.notEqual(s1.record?.runSeed, s2.record?.runSeed);
});
