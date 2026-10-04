import { test } from 'node:test';
import assert from 'node:assert/strict';
import { occurrences, addDays, daysInMonth, parseDate, EngineError } from '../src/schedule.js';

const list = (rule) => [...occurrences(rule)];

test('leap-year boundary: monthly from Jan 31 clamps to Feb 29 / Feb 28', () => {
  assert.deepEqual(
    list({ freq: 'monthly', start: '2024-01-31', end: '2024-04-30' }),
    ['2024-01-31', '2024-02-29', '2024-03-31', '2024-04-30'],
  );
  assert.deepEqual(
    list({ freq: 'monthly', start: '2023-01-31', end: '2023-03-31' }),
    ['2023-01-31', '2023-02-28', '2023-03-31'],
  );
});

test('leap-year boundary: yearly Feb 29 clamps to Feb 28 in non-leap years', () => {
  assert.deepEqual(
    list({ freq: 'yearly', start: '2024-02-29', end: '2028-03-01' }),
    ['2024-02-29', '2025-02-28', '2026-02-28', '2027-02-28', '2028-02-29'],
  );
});

test('weekly and daily step across month and year boundaries', () => {
  assert.deepEqual(
    list({ freq: 'weekly', start: '2024-02-26', end: '2024-03-18' }),
    ['2024-02-26', '2024-03-04', '2024-03-11', '2024-03-18'],
  );
  assert.deepEqual(
    list({ freq: 'daily', start: '2023-12-30', end: '2024-01-03', interval: 2 }),
    ['2023-12-30', '2024-01-01', '2024-01-03'],
  );
});

test('BAD_RANGE when end < start; never a silent empty plan', () => {
  assert.throws(() => list({ freq: 'monthly', start: '2024-05-01', end: '2024-04-01' }),
    (e) => e instanceof EngineError && e.code === 'BAD_RANGE');
  assert.throws(() => list({ freq: 'daily', start: '2024-05-02', end: '2024-05-01' }),
    (e) => e.code === 'BAD_RANGE');
});

test('small-scale enumeration cross-check: brute force vs generator', () => {
  const start = '2023-11-29';
  const end = '2024-05-31';
  const rules = [
    { freq: 'daily', interval: 3, start, end },
    { freq: 'weekly', interval: 2, start, end },
    { freq: 'monthly', interval: 1, start, end },
    { freq: 'monthly', interval: 2, start, end },
    { freq: 'yearly', interval: 1, start, end },
  ];
  const s = parseDate(start);
  const bruteForce = (rule) => {
    const out = [];
    for (let d = start; d <= end; d = addDays(d, 1)) {
      const { y, m, d: day } = parseDate(d);
      let hit = false;
      if (rule.freq === 'daily' || rule.freq === 'weekly') {
        const step = rule.freq === 'daily' ? rule.interval : 7 * rule.interval;
        const diffDays = Math.round((Date.UTC(y, m - 1, day) - Date.UTC(s.y, s.m - 1, s.d)) / 86400000);
        hit = diffDays % step === 0;
      } else if (rule.freq === 'monthly') {
        const monthDiff = (y - s.y) * 12 + (m - s.m);
        hit = monthDiff % rule.interval === 0 && day === Math.min(s.d, daysInMonth(y, m));
      } else {
        hit = m === s.m && day === Math.min(s.d, daysInMonth(y, m)) && (y - s.y) % rule.interval === 0;
      }
      if (hit) out.push(d);
    }
    return out;
  };
  for (const rule of rules) {
    assert.deepEqual(list(rule), bruteForce(rule), JSON.stringify(rule));
  }
});
