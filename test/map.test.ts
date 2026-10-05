import { test } from "node:test";
import assert from "node:assert/strict";
import { replaceAll, ReplaceSession } from "../src/index.js";

test("copied captures give one source position many output ranges", () => {
  const { text, map } = replaceAll(
    "xy",
    [
      {
        start: 0,
        end: 1,
        captures: [undefined, { start: 0, end: 1 }],
      },
    ],
    "$1$1",
  );
  assert.equal(text, "xxy");
  assert.equal(map.sourcePositionAt(0), 0);
  assert.equal(map.sourcePositionAt(1), 0);
  // The second copy of "x" merges with the adjacent "y" copy into one
  // maximal run copied from source [0, 2), and both runs contain source 0.
  assert.deepEqual(map.outputRangesForSource(0), [
    { start: 0, end: 1 },
    { start: 1, end: 3 },
  ]);
  assert.deepEqual(map.outputRangesForSource(1), [{ start: 1, end: 3 }]);
});

test("maps compose across rounds, inserted content stays source-less", () => {
  const session = new ReplaceSession("abcdef");
  session.apply([{ start: 1, end: 3 }], "[$&]"); // "a[bc]def"
  assert.equal(session.text, "a[bc]def");
  session.apply([{ start: 2, end: 3 }], "$&$&"); // "a[bbc]def"
  assert.equal(session.text, "a[bbc]def");

  assert.equal(session.sourcePositionAt(0), 0); // 'a'
  assert.equal(session.sourcePositionAt(1), null); // '[' inserted round 1
  assert.equal(session.sourcePositionAt(2), 1); // first copied 'b'
  assert.equal(session.sourcePositionAt(3), 1); // second copied 'b'
  assert.equal(session.sourcePositionAt(4), 2); // 'c'
  assert.equal(session.sourcePositionAt(5), null); // ']' inserted round 1
  assert.equal(session.sourcePositionAt(6), 3); // 'd'

  // Inverse query on the composed map returns every output range.
  assert.deepEqual(session.outputRangesForSource(1), [
    { start: 2, end: 3 },
    { start: 3, end: 5 },
  ]);
  assert.deepEqual(session.outputRangesForSource(4), [{ start: 6, end: 9 }]);
});
