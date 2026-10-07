'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { TimezoneTable } = require('../src/timezone');
const { Calendar, DAY_MS } = require('../src/calendar');
const { MINUTE_MS } = require('../src/timezone');

const table = new TimezoneTable({
  UTC: [{ from: 0, offsetMinutes: 0 }],
  'Test/Plus8': [{ from: 0, offsetMinutes: 480 }],
  // Spring-forward at utc DAY: offset 0 -> +60 (a local-time gap).
  'Test/Switch': [
    { from: 0, offsetMinutes: 0 },
    { from: DAY_MS, offsetMinutes: 60 },
  ],
  // Fall-back at utc DAY: offset +60 -> 0 (ambiguous local times).
  'Test/Fallback': [
    { from: 0, offsetMinutes: 60 },
    { from: DAY_MS, offsetMinutes: 0 },
  ],
});

test('explicit timezone table converts both directions', () => {
  assert.equal(table.utcToLocal('Test/Plus8', 0), 8 * 60 * MINUTE_MS);
  assert.equal(table.localToUtc('Test/Plus8', 8 * 60 * MINUTE_MS), 0);
  assert.equal(table.offsetMinutesAt('Test/Switch', DAY_MS - 1), 0);
  assert.equal(table.offsetMinutesAt('Test/Switch', DAY_MS), 60);
  assert.throws(() => table.utcToLocal('Nope/Zone', 0), /unknown timezone/);
});

test('acceptance 3: recurring shift across the offset-switch night', () => {
  const cal = new Calendar(table, {
    shifts: [{ id: 's1', tz: 'Test/Switch', freq: 'daily', timeOfDay: '02:00', durationMinutes: 60 }],
  });
  const occ = cal.shiftIntervals(0, 3 * DAY_MS);
  assert.deepEqual(
    occ.map((o) => [o.start, o.end]),
    [
      [2 * 60 * MINUTE_MS, 3 * 60 * MINUTE_MS],                   // day 0 at 02:00, offset +0
      [DAY_MS + 60 * MINUTE_MS, DAY_MS + 2 * 60 * MINUTE_MS],     // day 1 at 02:00, offset +60
      [2 * DAY_MS + 60 * MINUTE_MS, 2 * DAY_MS + 2 * 60 * MINUTE_MS], // day 2, offset +60
    ],
  );
  // Half-open: a window ending exactly at the first occurrence start excludes it.
  assert.equal(cal.shiftIntervals(0, 2 * 60 * MINUTE_MS).length, 0);
  assert.equal(cal.shiftIntervals(0, 2 * 60 * MINUTE_MS + 1).length, 1);
});

test('local times inside a forward-switch gap are skipped; fallback picks earliest era', () => {
  // Gap: local [DAY, DAY+60min) does not exist in Test/Switch.
  assert.throws(() => table.localToUtc('Test/Switch', DAY_MS + 30 * MINUTE_MS), /does not exist/);
  const calGap = new Calendar(table, {
    shifts: [{ tz: 'Test/Switch', freq: 'daily', timeOfDay: '00:30', durationMinutes: 30 }],
  });
  // Day 1 local 00:30 lands in the gap -> skipped; days 0, 2, 3 remain
  // (day 3 starts at 3*DAY - 30min, still inside the window).
  assert.deepEqual(
    calGap.shiftIntervals(0, 3 * DAY_MS).map((o) => o.start),
    [30 * MINUTE_MS, 2 * DAY_MS - 30 * MINUTE_MS, 3 * DAY_MS - 30 * MINUTE_MS],
  );

  // Ambiguous local time in Test/Fallback resolves to the earliest era (offset +60).
  assert.equal(table.localToUtc('Test/Fallback', DAY_MS + 30 * MINUTE_MS), DAY_MS - 30 * MINUTE_MS);
});

test('downtime exceptions cut shifts; handovers are half-open', () => {
  const cal = new Calendar(table, {
    shifts: [{ id: 's', tz: 'UTC', freq: 'daily', timeOfDay: '01:00', durationMinutes: 120 }],
    exceptions: [{ id: 'down', start: 90 * MINUTE_MS, end: 120 * MINUTE_MS }],
    handovers: [{ id: 'h', start: 180 * MINUTE_MS, end: 200 * MINUTE_MS }],
  });
  const busy = cal.busyIntervals(0, DAY_MS);
  assert.deepEqual(
    busy.map((b) => [b.start, b.end, b.kind]),
    [
      [60 * MINUTE_MS, 90 * MINUTE_MS, 'shift'],
      [120 * MINUTE_MS, 180 * MINUTE_MS, 'shift'],
      [180 * MINUTE_MS, 200 * MINUTE_MS, 'handover'],
    ],
  );
});

test('calendar validation errors: zero-duration period and inverted interval', () => {
  assert.throws(
    () => new Calendar(table, { shifts: [{ tz: 'UTC', freq: 'daily', timeOfDay: '01:00', durationMinutes: 0 }] }),
    (err) => err.code === 'ZERO_DURATION',
  );
  assert.throws(
    () => new Calendar(table, { exceptions: [{ start: 10, end: 5 }] }),
    (err) => err.code === 'INVERTED_INTERVAL',
  );
  assert.throws(
    () => new Calendar(table, { handovers: [{ start: 7, end: 7 }] }),
    (err) => err.code === 'ZERO_DURATION',
  );
});
