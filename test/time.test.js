import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  daysFromCivil,
  civilFromDays,
  dateToDayNumber,
  dayNumberToDate,
  parseUtcMinutes,
  parseLocalMinutes,
  formatUtcMinutes,
} from '../lib/time.js';

test('civil <-> days roundtrip over a wide range', () => {
  for (let z = -1000000; z <= 1000000; z += 9973) {
    const [y, m, d] = civilFromDays(z);
    assert.equal(daysFromCivil(y, m, d), z);
  }
});

test('known anchors', () => {
  assert.equal(dateToDayNumber('1970-01-01'), 0);
  assert.equal(dateToDayNumber('2024-06-10'), 19884);
  assert.equal(dayNumberToDate(0), '1970-01-01');
  assert.equal(dayNumberToDate(19884), '2024-06-10');
});

test('utc parse respects offsets and formats back', () => {
  assert.equal(parseUtcMinutes('1970-01-01T00:00Z'), 0);
  assert.equal(parseUtcMinutes('1970-01-01T08:00+08:00'), 0);
  assert.equal(parseUtcMinutes('2024-06-10T15:30:00Z'), 19884 * 1440 + 930);
  assert.equal(formatUtcMinutes(19884 * 1440 + 930), '2024-06-10T15:30Z');
});

test('local parse rejects sub-minute precision', () => {
  assert.equal(parseLocalMinutes('2024-03-10T02:30'), dateToDayNumber('2024-03-10') * 1440 + 150);
  assert.throws(() => parseLocalMinutes('2024-03-10T02:30:15'), /sub-minute/);
});
