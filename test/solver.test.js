import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { allocateOrder } from '../src/allocate.js';
import { solveAllocation } from '../src/solver.js';

const DAY = 86_400_000;
const BASE = Date.parse('2026-10-01T00:00:00Z');
const iso = (offsetDays) => new Date(BASE + offsetDays * DAY).toISOString().slice(0, 10);

const ORDER = {
  id: 'O1',
  material: 'M',
  quantity: 5,
  location: 'A',
  transferCostPerUnit: 7,
  date: iso(0),
};

const BATCHES = [
  { id: 'B1', material: 'M', quantity: 3, expiry: iso(10), quality: 'ok', location: 'A' },
  { id: 'B2', material: 'M', quantity: 4, expiry: iso(5), quality: 'ok', location: 'B' },
  { id: 'B3', material: 'M', quantity: 2, expiry: iso(20), quality: 'ok', location: 'A' },
  { id: 'B4', material: 'M', quantity: 9, expiry: iso(3), quality: 'quarantined', location: 'A' },
  { id: 'B5', material: 'N', quantity: 9, expiry: iso(3), quality: 'ok', location: 'A' },
];

function bruteForce(batches, order) {
  const eligible = batches.filter(
    (b) => b.material === order.material
      && b.quality !== 'quarantined'
      && Date.parse(b.expiry) >= Date.parse(order.date)
      && b.quantity > 0,
  );
  let best = null;
  const qtys = new Array(eligible.length).fill(0);
  const consider = (cost, maxRem) => {
    if (!best || cost < best.cost || (cost === best.cost && maxRem < best.maxRem)) {
      best = { cost, maxRem, qtys: qtys.slice() };
    }
  };
  (function rec(i, remaining, cost, maxRem) {
    if (remaining === 0) return consider(cost, maxRem);
    if (i === eligible.length) return;
    const b = eligible[i];
    const ub = Math.min(b.quantity, remaining);
    const cpu = b.location === order.location ? 0 : order.transferCostPerUnit;
    const rem = Math.floor((Date.parse(b.expiry) - Date.parse(order.date)) / DAY);
    for (let q = 0; q <= ub; q += 1) {
      qtys[i] = q;
      rec(i + 1, remaining - q, cost + q * cpu, q > 0 ? Math.max(maxRem, rem) : maxRem);
    }
    qtys[i] = 0;
  })(0, order.quantity, 0, -1);
  return best;
}

describe('acceptance 1: small-inventory enumeration cross-check', () => {
  it('matches brute-force optimum on cost and max remaining expiry', () => {
    const result = solveAllocation(BATCHES, ORDER);
    assert.equal(result.status, 'optimal');

    const expected = bruteForce(BATCHES, ORDER);
    assert.ok(expected, 'brute force found a solution');
    assert.equal(result.transferCost, expected.cost);
    assert.equal(result.maxRemainingDays, expected.maxRem);

    const total = result.allocation.reduce((sum, line) => sum + line.quantity, 0);
    assert.equal(total, ORDER.quantity);

    const byId = new Map(BATCHES.map((b) => [b.id, b]));
    for (const line of result.allocation) {
      const batch = byId.get(line.batchId);
      assert.ok(Number.isInteger(line.quantity) && line.quantity > 0);
      assert.ok(line.quantity <= batch.quantity, `${line.batchId} exceeds available`);
      assert.equal(batch.material, ORDER.material);
      assert.notEqual(batch.quality, 'quarantined');
      assert.ok(Date.parse(batch.expiry) >= Date.parse(ORDER.date));
    }

    // Every eligible batch combination is costed identically by solver and brute force.
    const solverCost = result.allocation.reduce((sum, line) => sum + line.transferCost, 0);
    assert.equal(solverCost, result.transferCost);
    assert.ok(!result.allocation.some((l) => l.batchId === 'B4' || l.batchId === 'B5'));
  });

  it('respects integer domains and per-batch caps across many random instances', () => {
    let seed = 42;
    const rand = () => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return seed / 2147483648;
    };
    for (let trial = 0; trial < 50; trial += 1) {
      const batches = Array.from({ length: 4 }, (_, i) => ({
        id: `R${i}`,
        material: 'M',
        quantity: 1 + Math.floor(rand() * 5),
        expiry: iso(1 + Math.floor(rand() * 15)),
        quality: 'ok',
        location: rand() < 0.5 ? 'A' : 'B',
      }));
      const order = { ...ORDER, quantity: 1 + Math.floor(rand() * 6) };
      const result = solveAllocation(batches, order);
      const expected = bruteForce(batches, order);
      if (!expected) {
        assert.equal(result.status, 'infeasible');
        continue;
      }
      assert.equal(result.status, 'optimal');
      assert.equal(result.transferCost, expected.cost, `trial ${trial} cost`);
      assert.equal(result.maxRemainingDays, expected.maxRem, `trial ${trial} maxRem`);
      assert.equal(result.allocation.reduce((s, l) => s + l.quantity, 0), order.quantity);
    }
  });
});

describe('acceptance 2: expiry boundary infeasibility', () => {
  it('reports conflicts when every batch expires before the order date', () => {
    const batches = [
      { id: 'E1', material: 'M', quantity: 10, expiry: iso(-1), quality: 'ok', location: 'A' },
      { id: 'E2', material: 'M', quantity: 10, expiry: iso(-30), quality: 'ok', location: 'B' },
    ];
    const result = solveAllocation(batches, ORDER);
    assert.equal(result.status, 'infeasible');
    const expired = result.conflicts.filter((c) => c.reason === 'expired').map((c) => c.batchId);
    assert.deepEqual(expired.sort(), ['E1', 'E2']);
    assert.ok(result.conflicts.some((c) => c.reason === 'insufficient-quantity' && c.available === 0));
  });

  it('treats a batch expiring exactly on the order date as eligible (boundary)', () => {
    const batches = [
      { id: 'E0', material: 'M', quantity: 5, expiry: iso(0), quality: 'ok', location: 'A' },
      { id: 'E1', material: 'M', quantity: 5, expiry: iso(-1), quality: 'ok', location: 'A' },
    ];
    const result = solveAllocation(batches, { ...ORDER, quantity: 5 });
    assert.equal(result.status, 'optimal');
    assert.deepEqual(result.allocation.map((l) => l.batchId), ['E0']);
    assert.equal(result.maxRemainingDays, 0);
  });

  it('is transactional: a failed order leaves the state object untouched', () => {
    const state = {
      batches: [{ id: 'E1', material: 'M', quantity: 10, expiry: iso(-1), quality: 'ok', location: 'A' }],
      orders: [],
      allocations: [],
    };
    const snapshot = structuredClone(state);
    const result = allocateOrder(state, ORDER);
    assert.equal(result.status, 'infeasible');
    assert.deepEqual(state, snapshot);
    assert.equal(result.state, state);
  });
});
