import { test } from 'node:test';
import { deepEqual, equal, ok, throws } from 'node:assert/strict';
import {
  attributeWork,
  attributeWorkSweep,
  type Shift,
} from '../src/attribute.js';
import type { Interval } from '../src/intervals.js';
import { mulberry32, randomInt } from './helpers.js';

test('fixed example: priority, tie-breaks and rest deduction', () => {
  const shifts: Shift[] = [
    { id: 1, start: 0, end: 10, priority: 1 },
    { id: 2, start: 5, end: 15, priority: 2 },
    { id: 3, start: 5, end: 8, priority: 2 },
    { id: 4, start: 12, end: 20, priority: 2 },
  ];
  const rests: Interval[] = [
    { start: 3, end: 4 },
    { start: 14, end: 16 },
  ];
  const result = attributeWork(shifts, rests);
  deepEqual(result.segments, [
    { shiftId: 1, start: 0, end: 3 },
    { shiftId: 1, start: 4, end: 5 },
    { shiftId: 2, start: 5, end: 14 },
    { shiftId: 4, start: 16, end: 20 },
  ]);
  deepEqual(result.totals, [
    { shiftId: 1, seconds: 4 },
    { shiftId: 2, seconds: 9 },
    { shiftId: 3, seconds: 0 },
    { shiftId: 4, seconds: 4 },
  ]);
  equal(result.totalSeconds, 17);
});

test('tie-break: same priority and start falls back to smaller id', () => {
  const shifts: Shift[] = [
    { id: 9, start: 0, end: 5, priority: 3 },
    { id: 4, start: 0, end: 5, priority: 3 },
  ];
  const result = attributeWork(shifts, []);
  deepEqual(result.segments, [{ shiftId: 4, start: 0, end: 5 }]);
  equal(result.totalSeconds, 5);
});

test('tie-break: same priority prefers earlier start', () => {
  const shifts: Shift[] = [
    { id: 1, start: 4, end: 9, priority: 2 },
    { id: 2, start: 2, end: 6, priority: 2 },
  ];
  const result = attributeWork(shifts, []);
  deepEqual(result.segments, [
    { shiftId: 2, start: 2, end: 6 },
    { shiftId: 1, start: 6, end: 9 },
  ]);
});

test('rest fully covering a shift yields zero seconds', () => {
  const shifts: Shift[] = [{ id: 1, start: 2, end: 6, priority: 1 }];
  const result = attributeWork(shifts, [{ start: 0, end: 10 }]);
  deepEqual(result.segments, []);
  deepEqual(result.totals, [{ shiftId: 1, seconds: 0 }]);
  equal(result.totalSeconds, 0);
});

test('empty input yields empty result', () => {
  const result = attributeWork([], []);
  deepEqual(result.segments, []);
  deepEqual(result.totals, []);
  equal(result.totalSeconds, 0);
});

test('invalid input is rejected', () => {
  throws(() => attributeWork([{ id: 1, start: 3, end: 3, priority: 1 }], []), /start must be before end/);
  throws(() => attributeWork([{ id: 1, start: 0.5, end: 3, priority: 1 }], []), /integers/);
  throws(
    () =>
      attributeWork(
        [
          { id: 1, start: 0, end: 3, priority: 1 },
          { id: 1, start: 4, end: 6, priority: 1 },
        ],
        [],
      ),
    /duplicate/,
  );
});

test('randomized: interval-difference model matches endpoint-sweep reference', () => {
  const rand = mulberry32(20261006);
  for (let iter = 0; iter < 1000; iter++) {
    const shiftCount = randomInt(rand, 0, 6);
    const shifts: Shift[] = [];
    for (let i = 0; i < shiftCount; i++) {
      const start = randomInt(rand, 0, 38);
      const end = start + randomInt(rand, 1, 8);
      shifts.push({ id: i + 1, start, end, priority: randomInt(rand, 0, 3) });
    }
    const rests: Interval[] = [];
    const restCount = randomInt(rand, 0, 3);
    for (let i = 0; i < restCount; i++) {
      const start = randomInt(rand, 0, 40);
      rests.push({ start, end: start + randomInt(rand, 1, 5) });
    }
    const a = attributeWork(shifts, rests);
    const b = attributeWorkSweep(shifts, rests);
    deepEqual(a.segments, b.segments, `segments differ at iter ${iter}`);
    deepEqual(a.totals, b.totals, `totals differ at iter ${iter}`);
    equal(a.totalSeconds, b.totalSeconds);

    const mergedRests = rests
      .slice()
      .sort((x, y) => x.start - y.start);
    let prevEnd = -Infinity;
    let sum = 0;
    for (const seg of a.segments) {
      ok(seg.start >= prevEnd, 'segments must not overlap');
      ok(seg.end > seg.start, 'segments must be non-empty');
      const owner = shifts.find((s) => s.id === seg.shiftId);
      ok(owner && owner.start <= seg.start && seg.end <= owner.end, 'segment inside owner');
      for (const r of mergedRests) {
        ok(seg.end <= r.start || seg.start >= r.end, 'segment outside rests');
      }
      prevEnd = seg.end;
      sum += seg.end - seg.start;
    }
    equal(sum, a.totalSeconds, 'totalSeconds equals sum of segments');
    equal(
      a.totals.reduce((acc, t) => acc + t.seconds, 0),
      a.totalSeconds,
      'totals sum to totalSeconds',
    );
  }
});
