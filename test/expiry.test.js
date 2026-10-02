'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { solve } = require('../src/solver');

const STATE = {
  batches: [
    { id: 'EXP1', material: 'M1', quantity: 10, allocated: 0, expiryDate: '2026-09-30', qualityStatus: 'released', location: 'L1' },
    { id: 'EXP2', material: 'M1', quantity: 10, allocated: 0, expiryDate: '2026-10-01', qualityStatus: 'released', location: 'L1' },
    { id: 'SHORT', material: 'M1', quantity: 10, allocated: 0, expiryDate: '2026-10-20', qualityStatus: 'released', location: 'L1' },
  ],
  orders: [],
};

test('expiry boundary: all batches expired at order date -> infeasible', () => {
  const allExpired = { ...STATE, batches: STATE.batches.filter((b) => b.id !== 'SHORT') };
  const result = solve(allExpired, { id: 'O1', material: 'M1', quantity: 5, location: 'L1', date: '2026-10-02' });
  assert.equal(result.status, 'infeasible');
  const expiryConflicts = result.conflicts.filter((c) => c.reason === 'expired-or-insufficient-shelf-life');
  assert.equal(expiryConflicts.length, 2);
  assert.ok(expiryConflicts.every((c) => c.remainingDays < 0));
  assert.ok(result.conflicts.some((c) => c.reason === 'insufficient-quantity'));
});

test('boundary is inclusive: batch expiring exactly at required horizon stays eligible', () => {
  const order = {
    id: 'O2', material: 'M1', quantity: 5, location: 'L1', date: '2026-10-01',
    minRemainingShelfLifeDays: 19, // SHORT has exactly 19 days left
  };
  const result = solve(STATE, order);
  assert.equal(result.status, 'optimal');
  assert.deepEqual(result.allocations.map((a) => a.batchId), ['SHORT']);
});

test('one day stricter pushes the boundary batch out -> infeasible', () => {
  const order = {
    id: 'O3', material: 'M1', quantity: 5, location: 'L1', date: '2026-10-01',
    minRemainingShelfLifeDays: 20,
  };
  const result = solve(STATE, order);
  assert.equal(result.status, 'infeasible');
  const short = result.conflicts.find((c) => c.batchId === 'SHORT');
  assert.equal(short.reason, 'expired-or-insufficient-shelf-life');
  assert.equal(short.remainingDays, 19);
  assert.equal(short.requiredDays, 20);
});
