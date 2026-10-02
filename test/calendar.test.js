import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadCalendar, isBusinessDay, nextBusinessDay, settlementDateFor, settlementInterval, mergeIntervals } from '../src/calendar.js';
import { loadTzTable } from '../src/tztable.js';
import { parseDate, parseLocal, parseUtc, formatDate } from '../src/civil.js';
import { tzdbRaw, calendarsRaw } from './helpers.js';

const tz = loadTzTable(tzdbRaw);
const ny = loadCalendar(calendarsRaw[0]);
const sha = loadCalendar(calendarsRaw[2]);
const D = parseDate;
const L = parseLocal;

test('business days skip weekends and holidays', () => {
  assert.equal(isBusinessDay(ny, D('2024-06-07')), true); // Friday
  assert.equal(isBusinessDay(ny, D('2024-06-08')), false); // Saturday
  assert.equal(isBusinessDay(ny, D('2024-06-19')), false); // Juneteenth
  assert.equal(isBusinessDay(sha, D('2024-06-10')), false); // Dragon Boat Festival
});

test('nextBusinessDay rolls over weekends/holidays and stops at the horizon', () => {
  assert.equal(nextBusinessDay(ny, D('2024-06-07')), D('2024-06-10'));
  assert.equal(nextBusinessDay(ny, D('2024-12-24')), D('2024-12-26'));
  assert.equal(nextBusinessDay(ny, D('2025-12-31')), null); // beyond horizon
});

test('settlement date: cutoff splits the local day', () => {
  assert.equal(settlementDateFor(ny, L('2024-06-10T16:59')), D('2024-06-10'));
  assert.equal(settlementDateFor(ny, L('2024-06-10T17:00')), D('2024-06-11')); // exactly on cutoff -> next day
  assert.equal(settlementDateFor(ny, L('2024-06-10T17:01')), D('2024-06-11'));
  assert.equal(settlementDateFor(ny, L('2024-06-14T18:00')), D('2024-06-17')); // Friday night -> Monday
  assert.equal(settlementDateFor(ny, L('2024-06-15T10:00')), D('2024-06-17')); // Saturday -> Monday
  assert.equal(settlementDateFor(ny, L('2024-06-18T23:00')), D('2024-06-20')); // skips Juneteenth
});

test('settlement interval is [cutoff(prevBizDay), cutoff(day)) in UTC', () => {
  const iv = settlementInterval(tz, ny, D('2024-06-10'));
  assert.equal(iv.date, '2024-06-10');
  assert.equal(iv.startUtcMin, parseUtc('2024-06-07T21:00Z')); // Fri 17:00 EDT
  assert.equal(iv.endUtcMin, parseUtc('2024-06-10T21:00Z')); // Mon 17:00 EDT
});

test('settlement intervals shift with DST transitions', () => {
  const before = settlementInterval(tz, ny, D('2024-03-08'));
  const after = settlementInterval(tz, ny, D('2024-03-11'));
  assert.equal(before.endUtcMin, parseUtc('2024-03-08T22:00Z')); // 17:00 EST
  assert.equal(after.endUtcMin, parseUtc('2024-03-11T21:00Z')); // 17:00 EDT
});

test('mergeIntervals merges contiguous day intervals into one span', () => {
  const days = ['2024-06-10', '2024-06-11', '2024-06-12'].map(D);
  const merged = mergeIntervals(days.map((d) => settlementInterval(tz, ny, d)));
  assert.equal(merged.length, 1);
  assert.equal(merged[0].dayCount, 3);
  assert.equal(merged[0].fromDate, '2024-06-10');
  assert.equal(merged[0].toDate, '2024-06-12');
  assert.equal(formatDate(D(merged[0].fromDate)), '2024-06-10');
});
