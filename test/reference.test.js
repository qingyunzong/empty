'use strict';

// Acceptance 3: cross-check the library against a reference algorithm that
// enumerates every interval-intersection combination, including recurring
// shifts spanning an offset-switch night.

const test = require('node:test');
const assert = require('node:assert/strict');
const { TimezoneTable, MINUTE_MS } = require('../src/timezone');
const { Calendar, DAY_MS } = require('../src/calendar');
const { overlaps, intersection } = require('../src/intervals');

const SWITCH_DAY = 7; // offset switches at utc day 7
const SWITCH_UTC = SWITCH_DAY * DAY_MS;

const table = new TimezoneTable({
  'Test/Night': [
    { from: 0, offsetMinutes: -120 },
    { from: SWITCH_UTC, offsetMinutes: 180 },
  ],
});

// Reference local->utc: try every era's offset, keep the candidate that
// lands inside that era's utc range. Different formulation from the library.
function refLocalToUtc(eras, localMs) {
  for (let i = 0; i < eras.length; i++) {
    const cand = localMs - eras[i].offsetMinutes * MINUTE_MS;
    const hi = i + 1 < eras.length ? eras[i + 1].from : Infinity;
    if (cand >= eras[i].from && cand < hi) return cand;
  }
  return null; // inside a gap
}

function refExpandShift(eras, shift, windowStart, windowEnd) {
  const out = [];
  const firstDay = Math.floor((windowStart - 2 * DAY_MS) / DAY_MS) - 1;
  const lastDay = Math.ceil((windowEnd + 2 * DAY_MS) / DAY_MS) + 1;
  for (let day = firstDay; day <= lastDay; day++) {
    const local = day * DAY_MS + shift.timeOfDayMs;
    const utc = refLocalToUtc(eras, local);
    if (utc === null) continue;
    const end = utc + shift.durationMinutes * MINUTE_MS;
    if (utc < windowEnd && end > windowStart) out.push({ start: utc, end });
  }
  return out;
}

// Reference busy coverage: split the window at every primitive endpoint into
// elementary segments and decide coverage per segment.
function refBusyCoverage(prims, windowStart, windowEnd) {
  const points = new Set([windowStart, windowEnd]);
  for (const p of prims) {
    points.add(Math.max(windowStart, Math.min(windowEnd, p.start)));
    points.add(Math.max(windowStart, Math.min(windowEnd, p.end)));
  }
  const sorted = [...points].sort((a, b) => a - b);
  const covered = [];
  const contains = (p, m) => m >= p.start && m < p.end;
  for (let i = 0; i + 1 < sorted.length; i++) {
    const a = sorted[i];
    const b = sorted[i + 1];
    if (a === b) continue;
    const shiftHit = prims.some((p) => p.kind === 'shift' && contains(p, a));
    const downHit = prims.some((p) => p.kind === 'exception' && contains(p, a));
    const handHit = prims.some((p) => p.kind === 'handover' && contains(p, a));
    if ((shiftHit && !downHit) || handHit) covered.push([a, b]);
  }
  const merged = [];
  for (const [a, b] of covered) {
    if (merged.length && merged[merged.length - 1][1] === a) merged[merged.length - 1][1] = b;
    else merged.push([a, b]);
  }
  return merged;
}

function mergeIntervals(list) {
  const sorted = list.map((iv) => [iv.start, iv.end]).sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const merged = [];
  for (const [a, b] of sorted) {
    if (merged.length && merged[merged.length - 1][1] >= a) {
      merged[merged.length - 1][1] = Math.max(merged[merged.length - 1][1], b);
    } else {
      merged.push([a, b]);
    }
  }
  return merged;
}

module.exports = { refLocalToUtc, refExpandShift, refBusyCoverage, mergeIntervals, table, SWITCH_UTC };
const ERAS = [
  { from: 0, offsetMinutes: -120 },
  { from: SWITCH_UTC, offsetMinutes: 180 },
];

test('reference: shift expansion across offset-switch night matches independent expander', () => {
  const shift = { id: 'night', tz: 'Test/Night', freq: 'daily', timeOfDay: '22:00', durationMinutes: 480 };
  const cal = new Calendar(table, { shifts: [shift] });
  const windowStart = (SWITCH_DAY - 3) * DAY_MS;
  const windowEnd = (SWITCH_DAY + 4) * DAY_MS;

  const expected = refExpandShift(ERAS, { timeOfDayMs: 22 * 60 * MINUTE_MS, durationMinutes: 480 }, windowStart, windowEnd);
  const actual = cal.shiftIntervals(windowStart, windowEnd).map((o) => ({ start: o.start, end: o.end }));
  assert.deepEqual(actual, expected);

  // The switch-night occurrence must straddle the jump: local 22:00 on day 7
  // maps to utc 19:00 under the new +180 offset.
  const nightOcc = actual.find((o) => o.start > SWITCH_UTC);
  assert.equal(nightOcc.start, SWITCH_UTC + 19 * 60 * MINUTE_MS);
});

test('reference: busy intervals match segment-enumeration coverage', () => {
  const cal = new Calendar(table, {
    shifts: [
      { id: 'a', tz: 'Test/Night', freq: 'daily', timeOfDay: '08:00', durationMinutes: 600 },
      { id: 'b', tz: 'Test/Night', freq: 'daily', timeOfDay: '20:00', durationMinutes: 240 },
    ],
    exceptions: [
      { id: 'down', start: SWITCH_UTC - 3 * 60 * MINUTE_MS, end: SWITCH_UTC + 2 * 60 * MINUTE_MS },
    ],
    handovers: [
      { id: 'h1', start: SWITCH_UTC + 90 * MINUTE_MS, end: SWITCH_UTC + 150 * MINUTE_MS },
    ],
  });
  const windowStart = (SWITCH_DAY - 2) * DAY_MS;
  const windowEnd = SWITCH_UTC + 2 * DAY_MS;

  const prims = [
    ...refExpandShift(ERAS, { timeOfDayMs: 8 * 60 * MINUTE_MS, durationMinutes: 600 }, windowStart, windowEnd).map((o) => ({ ...o, kind: 'shift' })),
    ...refExpandShift(ERAS, { timeOfDayMs: 20 * 60 * MINUTE_MS, durationMinutes: 240 }, windowStart, windowEnd).map((o) => ({ ...o, kind: 'shift' })),
    { start: SWITCH_UTC - 3 * 60 * MINUTE_MS, end: SWITCH_UTC + 2 * 60 * MINUTE_MS, kind: 'exception' },
    { start: SWITCH_UTC + 90 * MINUTE_MS, end: SWITCH_UTC + 150 * MINUTE_MS, kind: 'handover' },
  ];

  const expected = refBusyCoverage(prims, windowStart, windowEnd);
  const actual = mergeIntervals(cal.busyIntervals(windowStart, windowEnd));
  assert.deepEqual(actual, expected);
});

test('reference: every pairwise intersection matches brute-force per-ms sets', () => {
  let seed = 0xC0FFEE;
  const rand = () => {
    seed |= 0;
    seed = (seed + 0x6D2B79F5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };

  const intervals = [];
  for (let i = 0; i < 40; i++) {
    const a = Math.floor(rand() * 200);
    const len = 1 + Math.floor(rand() * 60);
    intervals.push({ start: a, end: a + len });
  }

  const bruteForceIntersection = (x, y) => {
    const xs = new Set();
    for (let m = x.start; m < x.end; m++) xs.add(m);
    let lo = null;
    let hi = null;
    for (let m = y.start; m < y.end; m++) {
      if (xs.has(m)) {
        if (lo === null) lo = m;
        hi = m + 1;
      }
    }
    return lo === null ? null : { start: lo, end: hi };
  };

  // Enumerate all intersection combinations.
  for (let i = 0; i < intervals.length; i++) {
    for (let j = 0; j < intervals.length; j++) {
      const x = intervals[i];
      const y = intervals[j];
      const lib = intersection(x.start, x.end, y.start, y.end);
      const ref = bruteForceIntersection(x, y);
      assert.deepEqual(lib, ref, `pair (${i}, ${j})`);
      assert.equal(overlaps(x.start, x.end, y.start, y.end), ref !== null);
    }
  }
});
