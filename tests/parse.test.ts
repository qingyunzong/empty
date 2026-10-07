import { test } from "node:test";
import assert from "node:assert/strict";
import { parsePath } from "../src/path.ts";

test("parses absolute move/line/close", () => {
  const subs = parsePath("M0 0 L10 0 L10 10 Z");
  assert.equal(subs.length, 1);
  assert.deepEqual(subs[0].points, [
    { x: 0, y: 0 },
    { x: 10, y: 0 },
    { x: 10, y: 10 },
  ]);
  assert.equal(subs[0].closed, true);
});

test("supports commas, extra whitespace and negative integers", () => {
  const subs = parsePath("M -3,-4  L 5 , -6 L7,8 z");
  assert.deepEqual(subs[0].points, [
    { x: -3, y: -4 },
    { x: 5, y: -6 },
    { x: 7, y: 8 },
  ]);
  assert.equal(subs[0].closed, true);
});

test("extra pairs after M become implicit lineto", () => {
  const subs = parsePath("M0 0 4 0 4 4 Z");
  assert.equal(subs[0].points.length, 3);
  assert.deepEqual(subs[0].points[2], { x: 4, y: 4 });
});

test("relative commands accumulate", () => {
  const subs = parsePath("m2 3 l4 0 l0 4 z");
  assert.deepEqual(subs[0].points, [
    { x: 2, y: 3 },
    { x: 6, y: 3 },
    { x: 6, y: 7 },
  ]);
  assert.equal(subs[0].closed, true);
});

test("multiple subpaths, open ones stay open for implicit fill closure", () => {
  const subs = parsePath("M0 0 L4 0 L4 4 M10 10 L14 10 Z");
  assert.equal(subs.length, 2);
  assert.equal(subs[0].closed, false);
  assert.equal(subs[1].closed, true);
});

test("rejects decimals, unknown commands and truncated input", () => {
  assert.throws(() => parsePath("M0 0 L1.5 2"), /invalid path syntax/);
  assert.throws(() => parsePath("M0 0 C1 2 3 4 5 6"), /invalid path syntax/);
  assert.throws(() => parsePath("M0 0 L5"), /expected integer coordinate/);
  assert.throws(() => parsePath("L1 1"), /lineto without an active subpath/);
  assert.throws(() => parsePath("M0 0 Z Z"), /close without an active subpath/);
});
