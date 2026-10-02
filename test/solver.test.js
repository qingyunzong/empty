'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { solve, filterCandidates } = require('../src/solver');

const STATE = {
  config: { transferCostPerUnit: 5 },
  batches: [
    { id: 'B1', material: 'M1', quantity: 4, allocated: 0, expiryDate: '2026-11-01', qualityStatus: 'released', location: 'L1' },
    { id: 'B2', material: 'M1', quantity: 3, allocated: 0, expiryDate: '2026-12-01', qualityStatus: 'released', location: 'L1' },
    { id: 'B3', material: 'M1', quantity: 5, allocated: 0, expiryDate: '2026-10-15', qualityStatus: 'released', location: 'L2' },
    { id: 'B4', material: 'M1', quantity: 10, allocated: 0, expiryDate: '2026-10-20', qualityStatus: 'quarantined', location: 'L1' },
    { id: 'B5', material: 'M2', quantity: 10, allocated: 0, expiryDate: '2026-10-20', qualityStatus: 'released', location: 'L1' },
  ],
  orders: [],
};

const ORDER = { id: 'O1', material: 'M1', quantity: 6, location: 'L1', date: '2026-10-01' };

/** Brute-force optimum over every batch combination and quantity split. */
function bruteForce(state, order) {
  const { candidates } = filterCandidates(state, order);
  let best = null;
  const take = new Array(candidates.length).fill(0);
  function go(i, remaining, cost, maxShelf) {
    if (remaining === 0) {
      if (!best || cost < best.cost || (cost === best.cost && maxShelf < best.maxShelf)) {
        best = { cost, maxShelf };
      }
      return;
    }
    if (i === candidates.length) return;
    for (let q = 0; q <= Math.min(candidates[i].hi, remaining); q++) {
      take[i] = q;
      go(i + 1, remaining - q, cost + q * candidates[i].unitTransferCost,
        q > 0 ? Math.max(maxShelf, candidates[i].remainingDays) : maxShelf);
    }
    take[i] = 0;
  }
  go(0, order.quantity, 0, 0);
  return best;
}

test('solver matches brute-force enumeration over batch combos and quantities', () => {
  for (const demand of [1, 2, 3, 5, 6, 7, 8, 9, 12]) {
    const order = { ...ORDER, quantity: demand };
    const expected = bruteForce(STATE, order);
    const result = solve(STATE, order);
    if (!expected) {
      assert.equal(result.status, 'infeasible', `demand ${demand} should be infeasible`);
      continue;
    }
    assert.equal(result.status, 'optimal', `demand ${demand} should be optimal`);
    assert.equal(result.transferCost, expected.cost, `demand ${demand} transfer cost`);
    assert.equal(result.maxRemainingShelfLifeDays, expected.maxShelf, `demand ${demand} max shelf life`);
    // quantity conservation and per-batch bounds
    const total = result.allocations.reduce((a, x) => a + x.quantity, 0);
    assert.equal(total, demand, `demand ${demand} conserved`);
    for (const alloc of result.allocations) {
      const batch = STATE.batches.find((b) => b.id === alloc.batchId);
      assert.ok(alloc.quantity <= batch.quantity - batch.allocated, `${alloc.batchId} within available`);
      assert.ok(Number.isInteger(alloc.quantity) && alloc.quantity > 0);
      assert.notEqual(batch.qualityStatus, 'quarantined');
      assert.equal(batch.material, order.material);
    }
  }
});

test('prefers same-location batches (zero transfer cost) over FEFO across locations', () => {
  const result = solve(STATE, { ...ORDER, quantity: 4 });
  assert.equal(result.status, 'optimal');
  assert.equal(result.transferCost, 0);
  assert.deepEqual(result.allocations.map((a) => a.batchId), ['B1']);
});

test('pays transfer cost only when same-location stock is insufficient', () => {
  const result = solve(STATE, { ...ORDER, quantity: 9 });
  assert.equal(result.status, 'optimal');
  // L1 eligible: B1(4) + B2(3) = 7, remaining 2 from B3 @L2 at 5/unit
  assert.equal(result.transferCost, 10);
  const b3 = result.allocations.find((a) => a.batchId === 'B3');
  assert.equal(b3.quantity, 2);
});

test('infeasible demand reports order/batch conflicts', () => {
  const result = solve(STATE, { ...ORDER, quantity: 100 });
  assert.equal(result.status, 'infeasible');
  const reasons = result.conflicts.map((c) => c.reason);
  assert.ok(reasons.includes('insufficient-quantity'));
  assert.ok(reasons.includes('quality-quarantined'));
  assert.ok(reasons.includes('material-mismatch'));
});

test('budget exhaustion returns unknown', () => {
  const result = solve(STATE, { ...ORDER, quantity: 6 }, { budget: 1 });
  assert.equal(result.status, 'unknown');
  assert.equal(result.reason, 'budget-exhausted');
});
