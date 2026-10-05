import { test } from "node:test";
import * as assert from "node:assert/strict";
import { intersect, mergeIntervals } from "../src/intervals.js";

test("并集：重叠、包含、相邻区间合并", () => {
  assert.deepEqual(
    mergeIntervals([
      { start: 10, end: 20 },
      { start: 15, end: 30 },
      { start: 30, end: 40 }, // 相邻（半开区间首尾相接）也合并
      { start: 5, end: 8 },
      { start: 12, end: 18 }, // 被包含
    ]),
    [
      { start: 5, end: 8 },
      { start: 10, end: 40 },
    ],
  );
});

test("并集：不相交区间保持分离且有序", () => {
  assert.deepEqual(
    mergeIntervals([
      { start: 100, end: 200 },
      { start: 0, end: 50 },
    ]),
    [
      { start: 0, end: 50 },
      { start: 100, end: 200 },
    ],
  );
});

test("并集：空输入与零长区间", () => {
  assert.deepEqual(mergeIntervals([]), []);
  assert.deepEqual(mergeIntervals([{ start: 5, end: 5 }]), []);
});

test("求交：半开区间边界", () => {
  assert.deepEqual(intersect({ start: 0, end: 10 }, { start: 5, end: 15 }), {
    start: 5,
    end: 10,
  });
  assert.equal(intersect({ start: 0, end: 10 }, { start: 10, end: 20 }), null);
  assert.equal(intersect({ start: 0, end: 10 }, { start: 20, end: 30 }), null);
});

test("非法区间报错", () => {
  assert.throws(() => mergeIntervals([{ start: 1.5, end: 2 }]));
  assert.throws(() => mergeIntervals([{ start: 9, end: 2 }]));
});
