import test from "node:test";
import assert from "node:assert/strict";
import { attributeReference, attributeSweep } from "../src/index";
import { Segment } from "../src/types";
import { mulberry32, randomShifts } from "./helpers";

function sortedTotals(totals: Map<number, number>): Array<[number, number]> {
  return [...totals.entries()].sort((a, b) => a[0] - b[0]);
}

test("overlap counted once, priority then earlier start then smaller id, rest deducted first", () => {
  const result = attributeSweep([
    { id: 1, priority: 5, work: [{ start: 0, end: 10 }], rest: [{ start: 2, end: 4 }] },
    { id: 3, priority: 5, work: [{ start: 5, end: 12 }] },
    { id: 2, priority: 7, work: [{ start: 8, end: 20 }] },
  ]);
  assert.deepEqual(result.segments, [
    { shiftId: 1, start: 0, end: 2 },
    { shiftId: 1, start: 4, end: 8 },
    { shiftId: 2, start: 8, end: 20 },
  ]);
  assert.equal(result.totals.get(1), 6);
  assert.equal(result.totals.get(2), 12);
  assert.equal(result.totals.get(3), undefined);
  assert.equal(result.totalSeconds, 18);
});

test("equal priority: earlier start wins over smaller id", () => {
  const result = attributeSweep([
    { id: 1, priority: 3, work: [{ start: 2, end: 8 }] },
    { id: 2, priority: 3, work: [{ start: 0, end: 4 }] },
  ]);
  assert.deepEqual(result.segments, [
    { shiftId: 2, start: 0, end: 4 },
    { shiftId: 1, start: 4, end: 8 },
  ]);
});

test("equal priority and equal start: smaller id wins", () => {
  const result = attributeSweep([
    { id: 5, priority: 3, work: [{ start: 0, end: 6 }] },
    { id: 2, priority: 3, work: [{ start: 0, end: 10 }] },
  ]);
  assert.deepEqual(result.segments, [{ shiftId: 2, start: 0, end: 10 }]);
  assert.equal(result.totalSeconds, 10);
});

test("rest interval of the only shift leaves a gap", () => {
  const result = attributeSweep([
    { id: 1, priority: 1, work: [{ start: 0, end: 6 }], rest: [{ start: 1, end: 3 }] },
  ]);
  assert.deepEqual(result.segments, [
    { shiftId: 1, start: 0, end: 1 },
    { shiftId: 1, start: 3, end: 6 },
  ]);
  assert.equal(result.totalSeconds, 4);
});

test("rest outside work is ignored; overlapping work intervals merge", () => {
  const result = attributeSweep([
    {
      id: 1,
      priority: 1,
      work: [
        { start: 0, end: 4 },
        { start: 3, end: 8 },
      ],
      rest: [{ start: 20, end: 25 }],
    },
  ]);
  assert.deepEqual(result.segments, [{ shiftId: 1, start: 0, end: 8 }]);
  assert.equal(result.totalSeconds, 8);
});

test("empty input yields empty attribution", () => {
  const result = attributeSweep([]);
  assert.deepEqual(result.segments, []);
  assert.equal(result.totalSeconds, 0);
});

test("endpoint sweep matches point-wise reference model (fuzz)", () => {
  const rng = mulberry32(20261005);
  for (let iter = 0; iter < 1000; iter++) {
    const shifts = randomShifts(rng, { maxShifts: 12, withCaps: false });
    const swept = attributeSweep(shifts);
    const referenced = attributeReference(shifts);
    assert.deepEqual(
      swept.segments.map((s: Segment) => [s.shiftId, s.start, s.end]),
      referenced.segments.map((s: Segment) => [s.shiftId, s.start, s.end]),
      `segments differ at iteration ${iter}`,
    );
    assert.deepEqual(sortedTotals(swept.totals), sortedTotals(referenced.totals));
    assert.equal(swept.totalSeconds, referenced.totalSeconds);
  }
});

test("validation rejects bad input", () => {
  assert.throws(
    () => attributeSweep([{ id: 1, priority: 1, work: [{ start: 0, end: 31 }] }]),
    /0 <= start < end <= 30/,
  );
  assert.throws(
    () => attributeSweep([{ id: 1, priority: 1, work: [{ start: 0.5, end: 3 }] }]),
    /integers/,
  );
  assert.throws(
    () =>
      attributeSweep([
        { id: 1, priority: 1, work: [{ start: 0, end: 3 }] },
        { id: 1, priority: 2, work: [{ start: 0, end: 3 }] },
      ]),
    /duplicate shift id/,
  );
  assert.throws(
    () =>
      attributeSweep(
        Array.from({ length: 13 }, (_, i) => ({
          id: i + 1,
          priority: 1,
          work: [{ start: 0, end: 1 }],
        })),
      ),
    /at most 12/,
  );
});
