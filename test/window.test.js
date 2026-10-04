import test from 'node:test';
import assert from 'node:assert/strict';
import { TimezoneTable } from '../src/timezone.js';
import { QualityWindow } from '../src/window.js';

const DST_ZONE = {
  'X/DST': [
    { from: null, offsetMinutes: 0 },
    { from: '2026-03-29T01:00:00Z', offsetMinutes: 60 },
    { from: '2026-10-25T01:00:00Z', offsetMinutes: 0 },
  ],
};

function makeWindow(windowCfg, zones = DST_ZONE) {
  return new QualityWindow(windowCfg, new TimezoneTable(zones));
}

test('timezone table converts across offset segments', () => {
  const tz = new TimezoneTable(DST_ZONE);
  assert.equal(tz.offsetMinutesAt('X/DST', Date.parse('2026-01-15T00:00:00Z')), 0);
  assert.equal(tz.offsetMinutesAt('X/DST', Date.parse('2026-06-15T00:00:00Z')), 60);
  assert.equal(tz.offsetMinutesAt('X/DST', Date.parse('2026-12-15T00:00:00Z')), 0);
  assert.equal(tz.offsetMinutesAt('X/DST', Date.parse('2026-03-29T01:00:00Z')), 60);
  assert.equal(tz.offsetMinutesAt('X/DST', Date.parse('2026-03-29T00:59:59Z')), 0);
});

test('window membership follows local time across DST shift', () => {
  const win = makeWindow({
    zone: 'X/DST',
    weekly: [{ days: [1, 2, 3, 4, 5], start: '09:00', end: '17:00' }],
  });
  // Monday 2026-06-01: local 09:00 == 08:00 UTC in summer.
  assert.equal(win.contains(Date.parse('2026-06-01T08:30:00Z')), true);
  assert.equal(win.contains(Date.parse('2026-06-01T07:59:59Z')), false);
  // Monday 2026-01-05: local 09:00 == 09:00 UTC in winter.
  assert.equal(win.contains(Date.parse('2026-01-05T08:30:00Z')), false);
  assert.equal(win.contains(Date.parse('2026-01-05T09:30:00Z')), true);
  // Weekend is outside.
  assert.equal(win.contains(Date.parse('2026-06-06T12:00:00Z')), false);
});

test('holiday exception closes an otherwise open window', () => {
  const win = makeWindow({
    zone: 'X/DST',
    weekly: [{ days: [1, 2, 3, 4, 5], start: '09:00', end: '17:00' }],
    holidays: ['2026-06-01'],
  });
  assert.equal(win.contains(Date.parse('2026-06-01T10:00:00Z')), false);
  assert.equal(win.contains(Date.parse('2026-06-02T10:00:00Z')), true);
});

test('overnight window belongs to the day it starts', () => {
  const win = makeWindow({
    zone: 'X/DST',
    weekly: [{ days: [1], start: '22:00', end: '02:00' }],
  });
  // Monday 2026-01-05 23:30 local (winter, offset 0).
  assert.equal(win.contains(Date.parse('2026-01-05T23:30:00Z')), true);
  // Tuesday 01:00 local is still Monday's window.
  assert.equal(win.contains(Date.parse('2026-01-06T01:00:00Z')), true);
  assert.equal(win.contains(Date.parse('2026-01-06T03:00:00Z')), false);
});

test('illegal periods are rejected', () => {
  const tz = new TimezoneTable(DST_ZONE);
  assert.throws(() => new QualityWindow({ zone: 'X/DST', weekly: [{ days: [1], start: '09:00', end: '09:00' }] }, tz), /zero-length/);
  assert.throws(() => new QualityWindow({ zone: 'X/DST', weekly: [{ days: [7], start: '09:00', end: '10:00' }] }, tz), /days/);
  assert.throws(() => new QualityWindow({ zone: 'X/DST', weekly: [{ days: [1], start: '9am', end: '10:00' }] }, tz), /time-of-day/);
  assert.throws(() => new QualityWindow({ zone: 'X/DST', weekly: [], }, tz), /weekly/);
  assert.throws(() => new QualityWindow({ zone: 'Nowhere', weekly: [{ days: [1], start: '09:00', end: '10:00' }] }, tz), /unknown timezone/);
  assert.throws(() => new QualityWindow({ zone: 'X/DST', weekly: [{ days: [1], start: '09:00', end: '10:00' }], holidays: ['June 1'] }, tz), /holiday/);
  assert.throws(() => new TimezoneTable({ bad: [] }), /offset segment/);
});
