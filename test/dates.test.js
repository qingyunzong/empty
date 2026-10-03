import test from 'node:test';
import assert from 'node:assert/strict';
import { isValidDateString, addDays, compareDates, isLeapYear, toDays, fromDays } from '../lib/dates.js';

test('C: leap-year aware date validation', () => {
  assert.equal(isValidDateString('2024-02-29'), true);
  assert.equal(isValidDateString('2023-02-29'), false);
  assert.equal(isValidDateString('2000-02-29'), true);
  assert.equal(isValidDateString('2100-02-29'), false);
  assert.equal(isValidDateString('2025-02-30'), false);
  assert.equal(isValidDateString('2024-04-31'), false);
  assert.equal(isValidDateString('2024-13-01'), false);
  assert.equal(isValidDateString('2024-00-10'), false);
  assert.equal(isValidDateString('2024-1-1'), false);
  assert.equal(isValidDateString('abcd-ef-gh'), false);
  assert.equal(isValidDateString('20240101'), false);
  assert.equal(isValidDateString(42), false);
});

test('C: day arithmetic across the leap-day boundary', () => {
  assert.equal(addDays('2024-02-28', 1), '2024-02-29');
  assert.equal(addDays('2024-02-29', 1), '2024-03-01');
  assert.equal(addDays('2023-02-28', 1), '2023-03-01');
  assert.equal(addDays('2024-03-01', -1), '2024-02-29');
  assert.equal(addDays('2024-02-28', 365), '2025-02-27');
  assert.equal(addDays('2023-02-28', 365), '2024-02-28');
  assert.equal(addDays('2024-01-01', 366), '2025-01-01');
  assert.equal(addDays('2023-01-01', 365), '2024-01-01');
  assert.equal(addDays('2024-12-31', 1), '2025-01-01');
  assert.equal(addDays('2025-03-01', -365), '2024-03-01');
  assert.equal(addDays('2025-03-01', -366), '2024-02-29');
});

test('leap year classification', () => {
  assert.equal(isLeapYear(2024), true);
  assert.equal(isLeapYear(2023), false);
  assert.equal(isLeapYear(2000), true);
  assert.equal(isLeapYear(1900), false);
});

test('toDays/fromDays roundtrip and ordering', () => {
  for (const d of ['2024-02-29', '2025-01-01', '1999-12-31', '2100-03-01', '2024-02-28']) {
    assert.equal(fromDays(toDays(d)), d);
  }
  assert.ok(compareDates('2024-02-29', '2024-03-01') < 0);
  assert.ok(compareDates('2024-03-01', '2024-03-01') === 0);
  assert.ok(compareDates('2025-01-01', '2024-12-31') > 0);
});
