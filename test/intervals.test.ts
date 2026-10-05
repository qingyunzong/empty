import { test } from "node:test";
import { deepEqual, equal } from "node:assert/strict";
import { intersect, normalize, subtract, totalLength } from "../src/intervals.js";

test("normalize merges overlapping and touching intervals", () => {
  deepEqual(
    normalize([{ start: 5, end: 8 }, { start: 0, end: 3 }, { start: 3, end: 5 }, { start: 2, end: 4 }]),
    [{ start: 0, end: 8 }],
  );
});

test("subtract computes gaps inside the range only", () => {
  deepEqual(
    subtract({ start: 0, end: 100 }, [{ start: -10, end: 20 }, { start: 50, end: 60 }, { start: 90, end: 200 }]),
    [{ start: 20, end: 50 }, { start: 60, end: 90 }],
  );
});

test("subtract with full coverage yields no gaps", () => {
  deepEqual(subtract({ start: 0, end: 10 }, [{ start: 0, end: 10 }]), []);
});

test("intersect clips to common parts", () => {
  deepEqual(
    intersect([{ start: 0, end: 10 }, { start: 20, end: 30 }], [{ start: 5, end: 25 }]),
    [{ start: 5, end: 10 }, { start: 20, end: 25 }],
  );
});

test("totalLength sums interval lengths", () => {
  equal(totalLength([{ start: 0, end: 4 }, { start: 10, end: 12 }]), 6);
});
