import { test } from "node:test";
import assert from "node:assert/strict";
import {
  assertSnapshotsEqual,
  diff,
  formatPath,
  normalize,
  parsePath,
} from "../src/snapshot.js";
import type { JsonValue } from "../src/snapshot.js";

test("ignores volatile fields via public path rules", () => {
  const expected = { id: 1, meta: { timestamp: 111, requestId: "aaa" }, body: "ok" };
  const actual = { id: 1, meta: { timestamp: 222, requestId: "bbb" }, body: "ok" };
  const entries = diff(expected, actual, {
    ignore: ["$.meta.timestamp", "$.meta.requestId"],
  });
  assert.deepEqual(entries, []);
});

test("wildcard rules ignore volatile fields in arrays", () => {
  const expected = { items: [{ id: "a", v: 1 }, { id: "b", v: 2 }] };
  const actual = { items: [{ id: "x", v: 1 }, { id: "y", v: 2 }] };
  assert.deepEqual(diff(expected, actual, { ignore: ["$.items[*].id"] }), []);
  assert.deepEqual(diff(expected, actual, { ignore: ["$.items.*.id"] }), []);
});

test("array order is preserved by default", () => {
  const expected = { list: [1, 2, 3] };
  const actual = { list: [3, 2, 1] };
  const entries = diff(expected, actual);
  assert.deepEqual(
    entries.map((e) => e.path),
    ["$.list[0]", "$.list[2]"],
  );
  assert.deepEqual(entries[0], { path: "$.list[0]", kind: "value", expected: 1, actual: 3 });
});

test("ignoreArrayOrder opts out of order sensitivity", () => {
  const expected: JsonValue = { list: [{ a: 1 }, { b: 2 }] };
  const actual: JsonValue = { list: [{ b: 2 }, { a: 1 }] };
  assert.equal(diff(expected, actual).length > 0, true);
  assert.deepEqual(diff(expected, actual, { ignoreArrayOrder: true }), []);
});

test("ignore rule does not mask a missing key (structural)", () => {
  const expected = { meta: { timestamp: 111 } };
  const actual = { meta: {} };
  const entries = diff(expected, actual, { ignore: ["$.meta.timestamp"] });
  assert.deepEqual(entries, [
    { path: "$.meta.timestamp", kind: "structural", expected: 111, actual: undefined },
  ]);
});

test("ignore rule does not mask a type change (structural)", () => {
  const expected = { meta: { timestamp: 111 } };
  const actual = { meta: { timestamp: "111" } };
  const entries = diff(expected, actual, { ignore: ["$.meta.timestamp"] });
  assert.deepEqual(entries, [
    { path: "$.meta.timestamp", kind: "structural", expected: 111, actual: "111" },
  ]);
});

test("ignoring a container still verifies its structure", () => {
  const expected = { meta: { a: 1, b: [1, 2] } };
  const actual = { meta: { a: 99, b: [1, 2, 3], extra: true } };
  const entries = diff(expected, actual, { ignore: ["$.meta"] });
  assert.deepEqual(entries, [
    { path: "$.meta.b[2]", kind: "structural", expected: undefined, actual: 3 },
    { path: "$.meta.extra", kind: "structural", expected: undefined, actual: true },
  ]);
});

test("diff reports the minimal path with both original values", () => {
  const expected = { a: { b: { c: { d: 1, e: 2 } } } };
  const actual = { a: { b: { c: { d: 1, e: 42 } } } };
  const entries = diff(expected, actual);
  assert.equal(entries.length, 1);
  assert.deepEqual(entries[0], { path: "$.a.b.c.e", kind: "value", expected: 2, actual: 42 });
});

test("normalize is idempotent on a concrete example", () => {
  const value = { meta: { ts: 123, keep: "x" }, list: [1, { id: "a" }] };
  const rules = ["$.meta.ts", "$.list[*].id"];
  const once = normalize(value, rules);
  const twice = normalize(once, rules);
  assert.deepEqual(twice, once);
  assert.deepEqual(once, {
    meta: { ts: "__snapshot_ignored__:number", keep: "x" },
    list: [1, { id: "__snapshot_ignored__:string" }],
  });
});

test("normalize makes snapshots with volatile fields comparable", () => {
  const a = { ts: 1, payload: { n: 5 } };
  const b = { ts: 999, payload: { n: 5 } };
  assert.deepEqual(normalize(a, ["$.ts"]), normalize(b, ["$.ts"]));
});

test("normalize keeps structure under ignored containers", () => {
  const a = { meta: { x: 1 } };
  const b = { meta: { x: 2, y: 3 } };
  assert.notDeepEqual(normalize(a, ["$.meta"]), normalize(b, ["$.meta"]));
});

test("path parse/format round-trips, including weird keys", () => {
  const cases = [
    "$",
    "$.a.b.c",
    "$.items[0].id",
    "$.a[*].b",
    "$.a.*.b",
    '$["weird key"]',
    '$["0"]',
    '$["a.b"].c[3]',
    '$["quo\\"te"]',
  ];
  for (const rule of cases) {
    const segments = parsePath(rule);
    const concrete = segments.map((s) => (s === "*" ? "k" : s));
    if (!segments.includes("*")) {
      assert.equal(formatPath(concrete), rule);
    }
  }
  assert.deepEqual(parsePath("$.a[0].b"), ["a", 0, "b"]);
  assert.deepEqual(parsePath('$["0"]'), ["0"]);
  assert.deepEqual(parsePath("$[0]"), [0]);
});

test("invalid rules throw", () => {
  for (const bad of ["", "a.b", "$.", "$.a b", "$[", "$[abc]", '$["x]', "$..a"]) {
    assert.throws(() => parsePath(bad), /Invalid path rule/);
  }
});

test("assertSnapshotsEqual throws with paths and both values", () => {
  assert.throws(
    () => assertSnapshotsEqual({ a: 1 }, { a: 2 }),
    (err: unknown) => {
      const msg = String(err);
      return msg.includes("$.a") && msg.includes("expected: 1") && msg.includes("actual:   2");
    },
  );
  assertSnapshotsEqual({ a: 1 }, { a: 1 });
});
