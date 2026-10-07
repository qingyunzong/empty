"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { Sheet, SheetError, range } = require("../dist/sheet.js");

/** Expanded-cell model assertion helper. */
function assertGrid(sheet, expected) {
  assert.deepEqual(sheet.expand(expected.length, expected[0].length), expected);
  sheet.assertConsistent();
}

const _ = null;

test("merge: anchor value expands over the whole rectangle", () => {
  const s = new Sheet();
  s.set(0, 0, "A");
  s.merge(range(0, 0, 2, 3));
  assertGrid(s, [
    ["A", "A", "A", _],
    ["A", "A", "A", _],
  ]);
  assert.deepEqual(s.getMerges(), [{ row: 0, col: 0, rows: 2, cols: 3 }]);
});

test("merge: partial overlap with an existing merge is rejected", () => {
  const s = new Sheet();
  s.merge(range(0, 0, 2, 2));
  assert.throws(() => s.merge(range(1, 1, 2, 2)), SheetError);
  assert.deepEqual(s.getMerges(), [{ row: 0, col: 0, rows: 2, cols: 2 }]);
});

test("merge: fully contained merges are absorbed", () => {
  const s = new Sheet();
  s.set(0, 0, "top");
  s.merge(range(0, 0, 1, 2));
  s.merge(range(0, 0, 3, 3));
  assert.deepEqual(s.getMerges(), [{ row: 0, col: 0, rows: 3, cols: 3 }]);
  assertGrid(s, [
    ["top", "top", "top"],
    ["top", "top", "top"],
    ["top", "top", "top"],
  ]);
});

test("unmerge: splits a region; partial split is rejected", () => {
  const s = new Sheet();
  s.set(0, 0, "X");
  s.merge(range(0, 0, 2, 2));
  assert.throws(() => s.unmerge(range(0, 0, 1, 2)), SheetError); // clips rows 1
  s.unmerge(range(0, 0, 2, 2));
  assert.deepEqual(s.getMerges(), []);
  assertGrid(s, [
    ["X", _],
    [_, _],
  ]);
});

test("copy: replicates values and merges across regions", () => {
  const s = new Sheet();
  s.set(0, 0, "h");
  s.merge(range(0, 0, 1, 2));
  s.set(1, 0, 1);
  s.set(1, 1, 2);
  s.copy(range(0, 0, 2, 2), 4, 3);
  assert.deepEqual(s.getMerges(), [
    { row: 0, col: 0, rows: 1, cols: 2 },
    { row: 4, col: 3, rows: 1, cols: 2 },
  ]);
  assert.equal(s.get(4, 3), "h");
  assert.equal(s.get(4, 4), "h");
  assert.equal(s.get(5, 3), 1);
  assert.equal(s.get(5, 4), 2);
  s.assertConsistent();
});

test("copy: clipping part of a source merge is rejected, sheet untouched", () => {
  const s = new Sheet();
  s.set(0, 0, "M");
  s.merge(range(0, 0, 2, 2));
  const before = s.clone();
  assert.throws(() => s.copy(range(0, 0, 1, 2), 5, 5), SheetError); // cuts rows
  assert.throws(() => s.copy(range(0, 1, 2, 1), 5, 5), SheetError); // cuts cols
  assert.deepEqual(s.getMerges(), before.getMerges());
  assertGrid(s, [
    ["M", "M"],
    ["M", "M"],
  ]);
});

test("copy: destination partially covering an old merge is rejected", () => {
  const s = new Sheet();
  s.set(0, 0, "a");
  s.set(3, 3, "old");
  s.merge(range(3, 3, 2, 2));
  assert.throws(() => s.copy(range(0, 0, 1, 1), 3, 4), SheetError); // hits half
  assert.equal(s.get(3, 3), "old");
  assert.deepEqual(s.getMerges(), [{ row: 3, col: 3, rows: 2, cols: 2 }]);
});

test("copy: destination fully covering an old merge replaces it", () => {
  const s = new Sheet();
  s.set(0, 0, "n");
  s.merge(range(0, 0, 2, 2));
  s.set(5, 5, "old");
  s.merge(range(5, 5, 2, 2));
  s.copy(range(0, 0, 2, 2), 5, 5);
  assert.deepEqual(s.getMerges(), [
    { row: 0, col: 0, rows: 2, cols: 2 },
    { row: 5, col: 5, rows: 2, cols: 2 },
  ]);
  assert.equal(s.get(5, 5), "n");
  assert.equal(s.get(6, 6), "n");
  s.assertConsistent();
});

test("copy: overlapping source/destination reads a snapshot (no pollution)", () => {
  const s = new Sheet();
  // Row 0: 1 2 3 4, copy (0,0,1x3) -> (0,1). Naive in-place copy would
  // smear "1" across; snapshot semantics must yield 1 1 2 3.
  s.set(0, 0, 1);
  s.set(0, 1, 2);
  s.set(0, 2, 3);
  s.set(0, 3, 4);
  s.copy(range(0, 0, 1, 3), 0, 1);
  assertGrid(s, [[1, 1, 2, 3]]);

  // Vertical overlap carrying a merge: dst rows 1-2 overlap src row 1, and
  // the old merge (row 0) is untouched. A naive top-down in-place copy would
  // read back the just-written row 1 and smear "A" into row 2.
  const t = new Sheet();
  t.set(0, 0, "A");
  t.merge(range(0, 0, 1, 2));
  t.set(1, 0, 1);
  t.set(1, 1, 2);
  t.copy(range(0, 0, 2, 2), 1, 0);
  assertGrid(t, [
    ["A", "A"],
    ["A", "A"],
    [1, 2],
  ]);
  assert.deepEqual(t.getMerges(), [
    { row: 0, col: 0, rows: 1, cols: 2 },
    { row: 1, col: 0, rows: 1, cols: 2 },
  ]);

  // A destination that only partially covers an old merge is rejected even
  // when source and destination overlap.
  const u = new Sheet();
  u.set(0, 0, "M");
  u.merge(range(0, 0, 2, 1));
  assert.throws(() => u.copy(range(0, 0, 2, 1), 1, 0), SheetError);
  assertGrid(u, [["M"], ["M"]]);
});

test("batch: any failure leaves the sheet completely unmodified", () => {
  const s = new Sheet();
  s.set(0, 0, "keep");
  s.merge(range(2, 2, 2, 2));
  const before = s.expand(4, 4);
  const beforeMerges = s.getMerges();

  assert.throws(() =>
    s.batch([
      { type: "set", row: 0, col: 1, value: "changed" },
      { type: "merge", range: range(0, 0, 1, 2) },
      { type: "copy", src: range(2, 2, 1, 2), dstRow: 3, dstCol: 0 }, // clips merge
    ]),
    SheetError
  );
  assert.deepEqual(s.expand(4, 4), before);
  assert.deepEqual(s.getMerges(), beforeMerges);
  s.assertConsistent();
});

test("batch: all-valid ops commit together", () => {
  const s = new Sheet();
  s.batch([
    { type: "set", row: 0, col: 0, value: "x" },
    { type: "merge", range: range(0, 0, 1, 2) },
    { type: "copy", src: range(0, 0, 1, 2), dstRow: 2, dstCol: 0 },
    { type: "unmerge", range: range(0, 0, 1, 2) },
  ]);
  assert.deepEqual(s.getMerges(), [{ row: 2, col: 0, rows: 1, cols: 2 }]);
  assertGrid(s, [
    ["x", _],
    [_, _],
    ["x", "x"],
  ]);
});

test("set: writing into a covered cell writes the anchor", () => {
  const s = new Sheet();
  s.merge(range(1, 1, 2, 2));
  s.set(2, 2, "via-covered");
  assert.equal(s.get(1, 1), "via-covered");
  assertGrid(s, [
    [_, _, _],
    [_, "via-covered", "via-covered"],
    [_, "via-covered", "via-covered"],
  ]);
});

test("validation: degenerate and negative ranges are rejected", () => {
  const s = new Sheet();
  assert.throws(() => s.merge(range(0, 0, 1, 1)), SheetError);
  assert.throws(() => s.merge(range(-1, 0, 2, 2)), SheetError);
  assert.throws(() => s.copy(range(0, 0, 0, 2), 1, 1), SheetError);
});
