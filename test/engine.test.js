import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ClearingEngine } from '../lib/engine.js';
import { E } from '../lib/errors.js';
import { TZ, CAL } from './helpers.js';

const engine = () => new ClearingEngine({ tzTable: TZ, calendar: CAL });
const netOf = (report, calendar, account, day) =>
  report.nets.find((n) => n.calendar === calendar && n.account === account && n.day === day)?.net;

test('basic mapping, cutoff roll and half-open boundary', () => {
  const report = engine().settle([
    // Mon 2024-06-10 11:30 New York -> before 17:00 cutoff -> settles 06-10
    { id: 'a', account: 'x', calendar: 'NY', amount: 100, utc: '2024-06-10T15:30:00Z' },
    // Mon 17:00 New York exactly -> boundary hit -> belongs to next interval
    { id: 'b', account: 'x', calendar: 'NY', amount: 5, utc: '2024-06-10T21:00:00Z' },
    // Mon 17:00:01 -> next interval too
    { id: 'c', account: 'x', calendar: 'NY', amount: 7, utc: '2024-06-10T21:01:00Z' },
  ]);
  assert.equal(netOf(report, 'NY', 'x', '2024-06-10'), 100);
  assert.equal(netOf(report, 'NY', 'x', '2024-06-11'), 12);
  assert.deepEqual(report.certificate.boundaryHits, [
    {
      txId: 'b',
      calendar: 'NY',
      instantUtc: '2024-06-10T21:00Z',
      boundary: 'localStart',
      settlementDay: '2024-06-11',
    },
  ]);
});

test('weekend and holiday roll forward to next business day', () => {
  const report = engine().settle([
    // Fri 2024-06-14 18:00 NY -> after cutoff; Sat/Sun not business -> settles Mon 06-17
    { id: 'a', account: 'x', calendar: 'NY', amount: 10, utc: '2024-06-14T22:00:00Z' },
    // 2024-07-03 18:00 NY -> after cutoff; 07-04 holiday -> settles 07-05
    { id: 'b', account: 'x', calendar: 'NY', amount: 20, utc: '2024-07-03T22:00:00Z' },
  ]);
  assert.equal(netOf(report, 'NY', 'x', '2024-06-17'), 10);
  assert.equal(netOf(report, 'NY', 'x', '2024-07-05'), 20);
});

test('held transactions are pending with reasons and excluded from nets', () => {
  const report = engine().settle([
    { id: 'a', account: 'x', calendar: 'SH', amount: 1, utc: '2024-06-10T01:00:00Z', hold: true, holdReason: 'MANUAL_REVIEW' },
    { id: 'b', account: 'x', calendar: 'SH', amount: 2, utc: '2024-06-10T02:00:00Z' },
  ]);
  assert.deepEqual(report.pending, [
    { txId: 'a', calendar: 'SH', account: 'x', reason: 'MANUAL_REVIEW' },
  ]);
  assert.equal(netOf(report, 'SH', 'x', '2024-06-10'), 2);
});

test('E_ORDER: out-of-order, duplicate id, unknown reversal target', () => {
  assert.throws(
    () => engine().settle([
      { id: 'a', account: 'x', calendar: 'NY', amount: 1, utc: '2024-06-10T15:00:00Z' },
      { id: 'b', account: 'x', calendar: 'NY', amount: 1, utc: '2024-06-10T14:00:00Z' },
    ]),
    (err) => err.code === E.ORDER,
  );
  assert.throws(
    () => engine().settle([
      { id: 'a', account: 'x', calendar: 'NY', amount: 1, utc: '2024-06-10T15:00:00Z' },
      { id: 'a', account: 'x', calendar: 'NY', amount: 1, utc: '2024-06-10T16:00:00Z' },
    ]),
    (err) => err.code === E.ORDER,
  );
  assert.throws(
    () => engine().settle([
      { id: 'r', type: 'reversal', reverses: 'nope', utc: '2024-06-10T16:00:00Z' },
    ]),
    (err) => err.code === E.ORDER,
  );
});

test('E_TZ_UNKNOWN: unknown calendar id', () => {
  assert.throws(
    () => engine().settle([{ id: 'a', account: 'x', calendar: 'XX', amount: 1, utc: '2024-06-10T15:00:00Z' }]),
    (err) => err.code === E.TZ_UNKNOWN,
  );
});

test('certificate is deterministic and replayable', () => {
  const txs = [
    { id: 'a', account: 'x', calendar: 'NY', amount: 3, utc: '2024-06-10T15:00:00Z' },
    { id: 'b', account: 'y', calendar: 'LN', amount: -4, utc: '2024-06-10T15:30:00Z' },
  ];
  const r1 = engine().settle(txs);
  const r2 = engine().settle(txs.map((t) => ({ ...t })));
  assert.equal(r1.certificate.certificateHash, r2.certificate.certificateHash);
  assert.match(r1.certificate.certificateHash, /^[0-9a-f]{64}$/);
  assert.equal(r1.certificate.tzVersion, 'tz-2024a-mini');
  assert.equal(r1.certificate.calendarVersion, 'cal-2024.1');
});
