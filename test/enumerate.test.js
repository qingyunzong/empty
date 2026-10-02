import test from 'node:test';
import assert from 'node:assert/strict';
import { enumerateTimings } from '../src/verify.js';

const config = {
  lines: [{ id: 'L1', budgetPerShift: 320 }],
  stations: [
    { id: 'DIAG', lineId: 'L1', capacityPerShift: 120 },
    { id: 'REPAIR', lineId: 'L1', capacityPerShift: 120 },
    { id: 'RECHECK', lineId: 'L1', capacityPerShift: 120 },
  ],
};

const orders = [
  {
    id: 'W1',
    route: [
      { station: 'DIAG', minutes: 60 },
      { station: 'REPAIR', minutes: 60 },
      { station: 'RECHECK', minutes: 60 },
    ],
  },
  {
    id: 'W2',
    route: [
      { station: 'DIAG', minutes: 80 },
      { station: 'REPAIR', minutes: 50 },
    ],
  },
  {
    id: 'W3',
    priority: 'high',
    route: [
      { station: 'REPAIR', minutes: 70 },
      { station: 'RECHECK', minutes: 70 },
    ],
  },
  {
    id: 'W4',
    route: [{ station: 'RECHECK', minutes: 100 }],
  },
];

test('exhaustive timing enumeration (4 orders, 24 permutations) keeps all invariants', () => {
  const report = enumerateTimings(config, orders);
  assert.equal(report.permutationsChecked, 24);
  assert.deepEqual(report.violations, []);
  assert.ok(report.ok);
});

test('enumeration rejects more than 4 orders', () => {
  assert.throws(
    () => enumerateTimings(config, [...orders, { id: 'W5', route: [{ station: 'DIAG', minutes: 10 }] }]),
    /between 1 and 4/,
  );
});
