import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ClearingEngine } from '../lib/engine.js';
import { E } from '../lib/errors.js';
import { TZ, CAL } from './helpers.js';

const engine = () => new ClearingEngine({ tzTable: TZ, calendar: CAL });

// Acceptance 2: one transaction in the spring-forward gap and one in the
// fall-back overlap. Both must be REJECTED, never silently shifted.
test('spring gap local time is rejected with E_GAP', () => {
  assert.throws(
    () => engine().settle([
      { id: 'gap1', account: 'a', calendar: 'NY', amount: 100, local: '2024-03-10T02:30' },
    ]),
    (err) => err.code === E.GAP && /does not exist/.test(err.message),
  );
});

test('fall overlap local time is rejected with E_OVERLAP', () => {
  assert.throws(
    () => engine().settle([
      { id: 'ovl1', account: 'a', calendar: 'NY', amount: 100, local: '2024-11-03T01:30' },
    ]),
    (err) => err.code === E.OVERLAP && /ambiguous/.test(err.message),
  );
});

test('valid local times around the transitions map correctly', () => {
  const report = engine().settle([
    // 2024-03-08 (Fri) 18:00 EST -> after cutoff -> settles Mon 03-11
    { id: 'a', account: 'a', calendar: 'NY', amount: 1, local: '2024-03-08T18:00' },
    // 2024-03-11 (Mon) 09:00 EDT -> before cutoff -> settles 03-11
    { id: 'b', account: 'a', calendar: 'NY', amount: 2, local: '2024-03-11T09:00' },
    // 2024-11-01 (Fri) 16:59 EDT -> before cutoff -> settles 11-01
    { id: 'c', account: 'a', calendar: 'NY', amount: 4, local: '2024-11-01T16:59' },
    // 2024-11-04 (Mon) 17:00 EST exactly -> boundary -> settles 11-05
    { id: 'd', account: 'a', calendar: 'NY', amount: 8, local: '2024-11-04T17:00' },
  ]);
  const net = (day) => report.nets.find((n) => n.calendar === 'NY' && n.day === day)?.net;
  assert.equal(net('2024-03-11'), 3);
  assert.equal(net('2024-11-01'), 4);
  assert.equal(net('2024-11-05'), 8);
  assert.equal(report.certificate.boundaryHits.length, 1);
  assert.equal(report.certificate.boundaryHits[0].txId, 'd');
});

test('utc-stamped transactions are never gap/overlap rejected', () => {
  // 2024-03-10T06:30Z is 01:30 EST (exists); 07:30Z is 03:30 EDT (exists).
  const report = engine().settle([
    { id: 'a', account: 'a', calendar: 'NY', amount: 1, utc: '2024-03-10T06:30:00Z' },
    { id: 'b', account: 'a', calendar: 'NY', amount: 1, utc: '2024-03-10T07:30:00Z' },
  ]);
  assert.equal(report.nets.length, 1);
});
