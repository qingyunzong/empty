'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { run } = require('../lib/allocate');

const threeCenters = () => [
  { id: 'A', tiers: [20, 30, 40, 50] },
  { id: 'B', tiers: [20, 30, 40, 50] },
  { id: 'C', tiers: [20, 30, 40, 50] },
];

test('acceptance 1: three cost centers, feasible allocation summing to 100%', () => {
  const result = run({ totalAmount: 10000, costCenters: threeCenters() });
  assert.equal(result.status, 'FEASIBLE');
  assert.equal(result.allocation.length, 3);
  assert.equal(result.allocation.reduce((s, a) => s + a.ratio, 0), 100);
  assert.equal(result.allocation.reduce((s, a) => s + a.amount, 0), 10000);
  assert.equal(result.lockedAmount, 0);
  assert.equal(result.pendingAmount, 10000);
  assert.equal(result.conflictCenters, null);
  assert.ok(result.trace.some((e) => e.event === 'solve'));
});

test('acceptance 2: adjustment re-selects only unlocked centers incrementally', () => {
  const result = run({
    totalAmount: 10000,
    costCenters: threeCenters(),
    adjustments: [{ id: 'ADJ-1', set: { C: 30 } }],
  });
  assert.equal(result.status, 'FEASIBLE');
  const byId = Object.fromEntries(result.allocation.map((a) => [a.center, a]));
  // Base solution is A=20, B=30, C=50; locking C=30 forces B to move 30 -> 50.
  assert.deepEqual(
    Object.fromEntries(result.allocation.map((a) => [a.center, a.ratio])),
    { A: 20, B: 50, C: 30 },
  );
  assert.equal(byId.C.locked, true);
  assert.equal(byId.A.locked, false);
  assert.equal(result.lockedAmount, 3000);
  assert.equal(result.pendingAmount, 7000);
  // Incremental: the re-solve scope excludes the locked center.
  const solves = result.trace.filter((e) => e.event === 'solve');
  assert.deepEqual(solves[solves.length - 1].scope, ['A', 'B']);
  const adjust = result.trace.find((e) => e.event === 'adjust');
  assert.deepEqual(adjust.changed.map((c) => c.center).sort(), ['B', 'C']);
});

test('acceptance 2b: cancellation restores the pre-layer occupancy', () => {
  const result = run({
    totalAmount: 10000,
    costCenters: threeCenters(),
    adjustments: [{ id: 'ADJ-1', set: { C: 30 } }],
    cancellations: [{ target: 'ADJ-1' }],
  });
  assert.equal(result.status, 'FEASIBLE');
  assert.deepEqual(
    Object.fromEntries(result.allocation.map((a) => [a.center, a.ratio])),
    { A: 20, B: 30, C: 50 },
  );
  assert.ok(result.allocation.every((a) => !a.locked));
  assert.equal(result.lockedAmount, 0);
  const cancel = result.trace.find((e) => e.event === 'cancel');
  assert.equal(cancel.target, 'ADJ-1');
  assert.deepEqual(cancel.restored, { A: 20, B: 30, C: 50 });
});

test('acceptance 3: mutually exclusive bounds produce UNSAT with minimal conflict set', () => {
  const result = run({
    totalAmount: 10000,
    costCenters: [
      { id: 'A', tiers: [60, 70] },
      { id: 'B', tiers: [50, 60] },
      { id: 'C', tiers: [10, 20] },
    ],
  });
  assert.equal(result.status, 'UNSAT');
  assert.deepEqual(result.conflictCenters, ['A', 'B']);
  assert.equal(result.allocation, null);
  assert.equal(result.lockedAmount, null);
});

test('acceptance 4: exhausted search budget yields PENDING, never UNSAT', () => {
  const result = run({
    totalAmount: 10000,
    searchBudget: 1,
    costCenters: [
      { id: 'A', tiers: [10, 20, 30, 40, 50] },
      { id: 'B', tiers: [10, 20, 30, 40, 50] },
      { id: 'C', tiers: [10, 20, 30, 40, 50] },
    ],
  });
  assert.equal(result.status, 'PENDING');
  assert.equal(result.conflictCenters, null);
  assert.equal(result.allocation, null);
});

test('propagation deletes ratios violating caps before search', () => {
  const result = run({
    totalAmount: 10000,
    costCenters: [
      { id: 'A', tiers: [10, 50, 90], maxAmount: 4000 },
      { id: 'B', tiers: [10, 50, 90] },
    ],
  });
  const prop = result.trace.find((e) => e.event === 'propagate' && e.center === 'A');
  assert.deepEqual(prop.removedRatios, [50, 90]);
  assert.equal(result.status, 'FEASIBLE');
  const byId = Object.fromEntries(result.allocation.map((a) => [a.center, a.ratio]));
  assert.deepEqual(byId, { A: 10, B: 90 });
});

test('explicit full ratios adjustment locks every center', () => {
  const result = run({
    totalAmount: 10000,
    costCenters: threeCenters(),
    adjustments: [{ id: 'ADJ-1', ratios: { A: 40, B: 40, C: 20 } }],
  });
  assert.equal(result.status, 'FEASIBLE');
  assert.ok(result.allocation.every((a) => a.locked));
  assert.equal(result.lockedAmount, 10000);
  assert.equal(result.pendingAmount, 0);
});
