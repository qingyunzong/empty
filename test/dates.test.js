import test from 'node:test';
import assert from 'node:assert/strict';
import { addDays, addMonthsClamped, isLeap, isValidDate, weekday } from '../src/dates.js';

test('leap year rules (gregorian, deterministic)', () => {
  assert.equal(isLeap(2000), true);
  assert.equal(isLeap(1900), false);
  assert.equal(isLeap(2024), true);
  assert.equal(isLeap(2025), false);
});

test('month-end clamping across leap boundary', () => {
  assert.equal(addMonthsClamped('2024-01-31', 1), '2024-02-29'); // leap
  assert.equal(addMonthsClamped('2023-01-31', 1), '2023-02-28'); // non-leap
  assert.equal(addMonthsClamped('2024-02-29', 12), '2025-02-28'); // leap -> non-leap
  assert.equal(addMonthsClamped('2024-01-31', 2), '2024-03-31'); // anchored, no drift
  assert.equal(addMonthsClamped('2024-12-15', 1), '2025-01-15');
});

test('addDays crosses month/year/leap boundaries in UTC', () => {
  assert.equal(addDays('2024-12-31', 1), '2025-01-01');
  assert.equal(addDays('2024-02-28', 1), '2024-02-29');
  assert.equal(addDays('2023-02-28', 1), '2023-03-01');
  assert.equal(addDays('2024-03-01', -1), '2024-02-29');
});

test('weekday and validation', () => {
  assert.equal(weekday('2024-02-29'), 4); // Thursday
  assert.equal(weekday('2024-03-31'), 0); // Sunday
  assert.equal(isValidDate('2024-02-29'), true);
  assert.equal(isValidDate('2023-02-29'), false);
  assert.equal(isValidDate('2024-13-01'), false);
});
