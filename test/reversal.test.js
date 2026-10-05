import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ClearingEngine, verifyReport } from '../lib/engine.js';
import { TZ, CAL } from './helpers.js';

const BASE = [
  { id: 't1', account: 'a', calendar: 'NY', amount: 1000, utc: '2024-06-10T14:00:00Z' },
  { id: 't2', account: 'a', calendar: 'NY', amount: 2000, utc: '2024-06-11T14:00:00Z' },
  { id: 't3', account: 'b', calendar: 'NY', amount: 4000, utc: '2024-06-12T14:00:00Z' },
  { id: 't4', account: 'a', calendar: 'LN', amount: 8000, utc: '2024-06-12T15:00:00Z' },
];
const CORRECTIONS = [
  { id: 'r1', type: 'reversal', reverses: 't2', utc: '2024-06-13T09:00:00Z' },
];

// Acceptance 3: corrections append reversals (history is kept), only the
// affected settlement day is recomputed, and the certificate replays.
test('reversal recomputes only the affected day and certificate replays', () => {
  const engine = new ClearingEngine({ tzTable: TZ, calendar: CAL });
  const before = engine.settle(BASE.map((t) => ({ ...t })));
  const netBefore = (cal, acct, day) =>
    before.nets.find((n) => n.calendar === cal && n.account === acct && n.day === day)?.net;
  assert.equal(netBefore('NY', 'a', '2024-06-11'), 2000);

  const after = engine.applyCorrections(CORRECTIONS.map((t) => ({ ...t })));

  // Only the original settlement day of t2 was recomputed.
  assert.deepEqual(after.recomputed.days, [{ calendar: 'NY', day: '2024-06-11' }]);
  assert.deepEqual(after.recomputed.mergedIntervals, [
    { calendar: 'NY', fromDay: '2024-06-11', toDay: '2024-06-11', days: 1 },
  ]);

  // History is append-only: all 5 txs are hashed into the certificate inputs.
  assert.equal(engine.txs.length, 5);
  assert.equal(engine.txs[1].amount, 2000); // t2 untouched

  // Net of the affected day is now zero; other days unchanged.
  const netAfter = (cal, acct, day) =>
    after.nets.find((n) => n.calendar === cal && n.account === acct && n.day === day)?.net;
  assert.equal(netAfter('NY', 'a', '2024-06-11'), 0);
  assert.equal(netAfter('NY', 'a', '2024-06-10'), 1000);
  assert.equal(netAfter('NY', 'b', '2024-06-12'), 4000);
  assert.equal(netAfter('LN', 'a', '2024-06-12'), 8000);

  // Incremental result must equal a from-scratch recompute of the full ledger,
  // including the certificate hash (replayable).
  const fresh = new ClearingEngine({ tzTable: TZ, calendar: CAL }).settle([...BASE, ...CORRECTIONS]);
  assert.deepEqual(after.nets, fresh.nets);
  assert.equal(after.certificate.certificateHash, fresh.certificate.certificateHash);

  // Certificate verifies against the combined inputs.
  assert.equal(
    verifyReport({ tzTable: TZ, calendar: CAL, transactions: [...BASE, ...CORRECTIONS] }, after),
    true,
  );
  // Tampered inputs must not verify.
  const tampered = [...BASE, ...CORRECTIONS].map((t) => ({ ...t }));
  tampered[0] = { ...tampered[0], amount: 9999 };
  assert.equal(verifyReport({ tzTable: TZ, calendar: CAL, transactions: tampered }, after), false);
});

test('corrections on adjacent days merge into one interval', () => {
  const engine = new ClearingEngine({ tzTable: TZ, calendar: CAL });
  engine.settle(BASE.map((t) => ({ ...t })));
  const after = engine.applyCorrections([
    { id: 'r1', type: 'reversal', reverses: 't1', utc: '2024-06-13T09:00:00Z' },
    { id: 'r2', type: 'reversal', reverses: 't2', utc: '2024-06-13T09:01:00Z' },
  ]);
  assert.deepEqual(after.recomputed.mergedIntervals, [
    { calendar: 'NY', fromDay: '2024-06-10', toDay: '2024-06-11', days: 2 },
  ]);
});
