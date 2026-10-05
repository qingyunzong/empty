import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ClearingEngine } from '../lib/engine.js';
import { TZ, CAL } from './helpers.js';

// Acceptance 1: the same UTC instant is cut into different settlement days by
// the New York / London / Shanghai calendars (all cut off at 17:00 local).
// 2024-06-10 is a Monday and a business day in all three calendars.
test('same-day cut comparison across NY / London / Shanghai', () => {
  const engine = new ClearingEngine({ tzTable: TZ, calendar: CAL });
  const report = engine.settle([
    { id: 'ny1', account: 'a', calendar: 'NY', amount: 1, utc: '2024-06-10T15:30:00Z' },
    { id: 'ln1', account: 'a', calendar: 'LN', amount: 1, utc: '2024-06-10T15:30:00Z' },
    { id: 'sh1', account: 'a', calendar: 'SH', amount: 1, utc: '2024-06-10T15:30:00Z' },
    { id: 'ny2', account: 'a', calendar: 'NY', amount: 1, utc: '2024-06-10T16:30:00Z' },
    { id: 'ln2', account: 'a', calendar: 'LN', amount: 1, utc: '2024-06-10T16:30:00Z' },
    { id: 'sh2', account: 'a', calendar: 'SH', amount: 1, utc: '2024-06-10T16:30:00Z' },
    { id: 'ny3', account: 'a', calendar: 'NY', amount: 1, utc: '2024-06-10T21:00:00Z' },
    { id: 'ln3', account: 'a', calendar: 'LN', amount: 1, utc: '2024-06-10T21:00:00Z' },
    { id: 'sh3', account: 'a', calendar: 'SH', amount: 1, utc: '2024-06-10T21:00:00Z' },
  ]);

  const dayOf = (cal) => {
    // each tx has amount 1; find which day bucket holds it via per-day counts
    const rows = report.nets.filter((n) => n.calendar === cal);
    return Object.fromEntries(rows.map((r) => [r.day, r.net]));
  };

  // 15:30Z: NY 11:30 (before cut) -> 06-10; LN 16:30 (before cut) -> 06-10;
  //         SH 23:30 (after cut) -> 06-11
  assert.deepEqual(dayOf('NY'), { '2024-06-10': 2, '2024-06-11': 1 });
  // 16:30Z: LN 17:30 (after cut) -> 06-11
  assert.deepEqual(dayOf('LN'), { '2024-06-10': 1, '2024-06-11': 2 });
  // SH: 15:30Z -> 23:30 (after cut); all three land on 06-11
  assert.deepEqual(dayOf('SH'), { '2024-06-11': 3 });

  // 21:00Z is exactly 17:00 in New York (EDT): half-open boundary hit.
  assert.deepEqual(report.certificate.boundaryHits, [
    {
      txId: 'ny3',
      calendar: 'NY',
      instantUtc: '2024-06-10T21:00Z',
      boundary: 'localStart',
      settlementDay: '2024-06-11',
    },
  ]);
});
