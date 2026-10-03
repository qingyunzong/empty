import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseDate, toDays, fromDays, addMonths, formatDate, isLeapYear, daysInMonth,
} from '../src/dates.js';

test('leap year rules (incl. century boundaries)', () => {
  assert.equal(isLeapYear(2024), true);
  assert.equal(isLeapYear(2023), false);
  assert.equal(isLeapYear(2000), true);
  assert.equal(isLeapYear(1900), false);
  assert.equal(daysInMonth(2024, 2), 29);
  assert.equal(daysInMonth(2025, 2), 28);
});

test('parseDate accepts only real calendar dates', () => {
  assert.deepEqual(parseDate('2024-02-29'), { y: 2024, m: 2, d: 29 });
  assert.equal(parseDate('2023-02-29'), null);
  assert.equal(parseDate('2024-13-01'), null);
  assert.equal(parseDate('2024-00-10'), null);
  assert.equal(parseDate('2024-04-31'), null);
  assert.equal(parseDate('2024-1-5'), null);
  assert.equal(parseDate('not-a-date'), null);
  assert.equal(parseDate(20240101), null);
  assert.equal(parseDate(undefined), null);
});

test('epoch-day conversion round-trips', () => {
  for (const s of ['2024-02-29', '2023-12-31', '2000-02-29', '1970-01-01', '2025-02-28']) {
    assert.equal(formatDate(fromDays(toDays(parseDate(s)))), s);
  }
  assert.equal(toDays(parseDate('1970-01-01')), 0);
});

test('addMonths clamps day to target month length', () => {
  assert.equal(formatDate(addMonths(parseDate('2024-01-31'), 1)), '2024-02-29');
  assert.equal(formatDate(addMonths(parseDate('2023-01-31'), 1)), '2023-02-28');
  assert.equal(formatDate(addMonths(parseDate('2024-02-29'), 12)), '2025-02-28');
  assert.equal(formatDate(addMonths(parseDate('2024-12-15'), 2)), '2025-02-15');
  assert.equal(formatDate(addMonths(parseDate('2024-06-30'), 1)), '2024-07-30');
});
