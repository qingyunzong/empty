import test from 'node:test';
import assert from 'node:assert/strict';
import { Calendar, mergeIntervals, subtractIntervals, MINUTE_MS } from '../src/calendar.js';
import { CODES, PlanError } from '../src/errors.js';

const T = (s) => Date.parse(s);

test('overlapping downtime intervals raise CALENDAR_OVERLAP', () => {
  const build = () =>
    new Calendar({
      start: '2026-10-05T00:00:00Z',
      shifts: [{ days: [1], start: '08:00', end: '16:00' }],
      downtime: [
        { start: '2026-10-05T10:00:00Z', end: '2026-10-05T12:00:00Z' },
        { start: '2026-10-05T11:00:00Z', end: '2026-10-05T13:00:00Z' },
      ],
    });
  assert.throws(build, (e) => e instanceof PlanError && e.code === CODES.CALENDAR_OVERLAP);
});

test('overlapping shifts on the same weekday raise CALENDAR_OVERLAP; different weekdays are fine', () => {
  const bad = () =>
    new Calendar({
      start: '2026-10-05T00:00:00Z',
      shifts: [
        { days: [1], start: '08:00', end: '12:00' },
        { days: [1], start: '11:00', end: '16:00' },
      ],
    });
  assert.throws(bad, (e) => e.code === CODES.CALENDAR_OVERLAP);
  const good = () =>
    new Calendar({
      start: '2026-10-05T00:00:00Z',
      shifts: [
        { days: [1], start: '08:00', end: '12:00' },
        { days: [2], start: '11:00', end: '16:00' },
      ],
    });
  assert.doesNotThrow(good);
});

test('acceptance 2: downtime sandwiched between busy ops yields no zero-length free gap', () => {
  const cal = new Calendar({
    start: '2026-10-05T08:00:00Z',
    shifts: [{ days: [1], start: '08:00', end: '16:00' }],
    downtime: [{ start: '2026-10-05T12:00:00Z', end: '2026-10-05T13:00:00Z' }],
  });
  const busy = [
    [T('2026-10-05T11:00:00Z'), T('2026-10-05T12:00:00Z')],
    [T('2026-10-05T13:00:00Z'), T('2026-10-05T14:00:00Z')],
  ];
  const dayEnd = T('2026-10-06T00:00:00Z');
  const free = [];
  for (const iv of cal.freeIntervalsFrom(busy, T('2026-10-05T08:00:00Z'))) {
    if (iv[0] >= dayEnd) break;
    free.push(iv);
  }
  assert.deepEqual(free, [
    [T('2026-10-05T08:00:00Z'), T('2026-10-05T11:00:00Z')],
    [T('2026-10-05T14:00:00Z'), T('2026-10-05T16:00:00Z')],
  ]);
  assert.ok(free.every(([s, e]) => e > s), 'no zero-length intervals');
});

test('acceptance 2: firstFit skips the zero-length gap and lands after the downtime', () => {
  const cal = new Calendar({
    start: '2026-10-05T08:00:00Z',
    shifts: [{ days: [1], start: '08:00', end: '16:00' }],
    downtime: [{ start: '2026-10-05T12:00:00Z', end: '2026-10-05T13:00:00Z' }],
  });
  const busy = [
    [T('2026-10-05T11:00:00Z'), T('2026-10-05T12:00:00Z')],
    [T('2026-10-05T13:00:00Z'), T('2026-10-05T14:00:00Z')],
  ];
  const start = cal.firstFit(busy, T('2026-10-05T11:30:00Z'), 60 * MINUTE_MS);
  assert.equal(start, T('2026-10-05T14:00:00Z'));
});

test('downtime abutting shift boundaries leaves working time intact (no zero-length fragments)', () => {
  const cal = new Calendar({
    start: '2026-10-05T00:00:00Z',
    shifts: [{ days: [1, 2], start: '08:00', end: '16:00' }],
    downtime: [{ start: '2026-10-05T16:00:00Z', end: '2026-10-06T08:00:00Z' }],
  });
  const intervals = [];
  for (const iv of cal.workingIntervalsFrom(T('2026-10-05T00:00:00Z'))) {
    intervals.push(iv);
    if (intervals.length === 2) break;
  }
  assert.deepEqual(intervals, [
    [T('2026-10-05T08:00:00Z'), T('2026-10-05T16:00:00Z')],
    [T('2026-10-06T08:00:00Z'), T('2026-10-06T16:00:00Z')],
  ]);
});

test('rest days remove working time', () => {
  const cal = new Calendar({
    start: '2026-10-05T00:00:00Z',
    shifts: [{ days: [1, 2], start: '08:00', end: '16:00' }],
    restDays: ['2026-10-05'],
  });
  const first = cal.workingIntervalsFrom(T('2026-10-05T00:00:00Z')).next().value;
  assert.deepEqual(first, [T('2026-10-06T08:00:00Z'), T('2026-10-06T16:00:00Z')]);
});

test('subtractIntervals drops zero-length results and ignores zero-length blocks', () => {
  assert.deepEqual(subtractIntervals([[0, 10]], [[0, 10]]), []);
  assert.deepEqual(subtractIntervals([[0, 10]], [[5, 5]]), [[0, 10]]);
  assert.deepEqual(subtractIntervals([[0, 10]], [[3, 5]]), [
    [0, 3],
    [5, 10],
  ]);
  assert.deepEqual(mergeIntervals([[0, 5], [5, 10], [12, 12], [10, 12]]), [[0, 12]]);
});
