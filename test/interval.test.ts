import { test } from "node:test";
import assert from "node:assert/strict";
import {
  coveredSeconds,
  intersectIntervals,
  unionIntervals,
} from "../src/interval.js";

test("并集：重叠区间合并", () => {
  assert.deepEqual(
    unionIntervals([
      { start: 10, end: 20 },
      { start: 15, end: 30 },
    ]),
    [{ start: 10, end: 30 }],
  );
});

test("并集：相邻区间合并（时间连续）", () => {
  assert.deepEqual(
    unionIntervals([
      { start: 0, end: 30 },
      { start: 30, end: 50 },
    ]),
    [{ start: 0, end: 50 }],
  );
});

test("并集：不相交区间保留且排序", () => {
  assert.deepEqual(
    unionIntervals([
      { start: 100, end: 200 },
      { start: 0, end: 10 },
      { start: 50, end: 60 },
    ]),
    [
      { start: 0, end: 10 },
      { start: 50, end: 60 },
      { start: 100, end: 200 },
    ],
  );
});

test("并集：包含关系被完全吸收", () => {
  assert.deepEqual(
    unionIntervals([
      { start: 0, end: 100 },
      { start: 20, end: 40 },
      { start: 60, end: 80 },
    ]),
    [{ start: 0, end: 100 }],
  );
});

test("交集：两组区间求交", () => {
  assert.deepEqual(
    intersectIntervals(
      [
        { start: 0, end: 100 },
        { start: 200, end: 300 },
      ],
      [
        { start: 50, end: 250 },
        { start: 400, end: 500 },
      ],
    ),
    [
      { start: 50, end: 100 },
      { start: 200, end: 250 },
    ],
  );
});

test("覆盖秒数", () => {
  assert.equal(
    coveredSeconds([
      { start: 0, end: 10 },
      { start: 20, end: 35 },
    ]),
    25,
  );
});

test("非法区间抛错", () => {
  assert.throws(() => unionIntervals([{ start: 5, end: 5 }]));
  assert.throws(() => unionIntervals([{ start: 0.5, end: 5 }]));
});
