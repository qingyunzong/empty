'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { planSchedule } = require('../src/schedule');
const { PlanError } = require('../src/errors');

// Reference implementation: enumerate every permutation, keep the feasible
// ones (daily machine capacity never exceeded, every order done by its due
// day), then pick the lexicographically smallest (due, id) key sequence.
function permutations(items) {
  if (items.length <= 1) return [items.slice()];
  const out = [];
  for (let i = 0; i < items.length; i += 1) {
    const rest = items.slice(0, i).concat(items.slice(i + 1));
    for (const tail of permutations(rest)) out.push([items[i], ...tail]);
  }
  return out;
}

function compareKeys(a, b) {
  for (let i = 0; i < a.length; i += 1) {
    if (a[i][0] !== b[i][0]) return a[i][0] - b[i][0];
    if (a[i][1] !== b[i][1]) return a[i][1] < b[i][1] ? -1 : 1;
  }
  return 0;
}

function bruteForce(orders, capacity) {
  let best = null;
  for (const perm of permutations(orders)) {
    let day = 0;
    let feasible = true;
    for (const o of perm) {
      const cap = capacity[o.machine];
      if (!Number.isFinite(cap) || cap <= 0) {
        feasible = false;
        break;
      }
      day += Math.ceil(o.quantity / cap);
      if (day > o.due) {
        feasible = false;
        break;
      }
    }
    if (!feasible) continue;
    const key = perm.map((o) => [o.due, o.id]);
    if (!best || compareKeys(key, best.key) < 0) {
      best = { key, ids: perm.map((o) => o.id) };
    }
  }
  return best ? best.ids : null;
}

function libraryIds(orders, capacity) {
  return planSchedule(orders, capacity).sequence.map((s) => s.id);
}

test('5-order example matches brute-force enumeration of all permutations', () => {
  const orders = [
    { id: 'WO-5', quantity: 30, due: 15, machine: 'M2' },
    { id: 'WO-1', quantity: 12, due: 4, machine: 'M1' },
    { id: 'WO-3', quantity: 8, due: 4, machine: 'M2' },
    { id: 'WO-2', quantity: 20, due: 9, machine: 'M1' },
    { id: 'WO-4', quantity: 5, due: 16, machine: 'M1' },
  ];
  const capacity = { M1: 6, M2: 5 };
  const expected = bruteForce(orders, capacity);
  assert.ok(expected, 'reference says the example is feasible');
  const plan = planSchedule(orders, capacity);
  assert.deepEqual(plan.sequence.map((s) => s.id), expected);
  // Spot-check the day arithmetic of the chosen sequence.
  let day = 0;
  for (const step of plan.sequence) {
    const order = orders.find((o) => o.id === step.id);
    day += Math.ceil(order.quantity / capacity[order.machine]);
    assert.equal(step.finish, day);
    assert.ok(step.finish <= order.due);
    assert.equal(step.start + (step.finish - step.start), step.finish);
  }
  assert.equal(plan.makespan, day);
});

test('infeasible capacity raises E_CAPACITY, matching the reference', () => {
  const orders = [
    { id: 'A', quantity: 10, due: 1, machine: 'M1' },
    { id: 'B', quantity: 10, due: 1, machine: 'M1' },
  ];
  assert.equal(bruteForce(orders, { M1: 5 }), null);
  assert.throws(() => planSchedule(orders, { M1: 5 }), (err) => {
    assert.ok(err instanceof PlanError);
    assert.equal(err.code, 'E_CAPACITY');
    return true;
  });
});

test('unknown machine capacity raises E_CAPACITY', () => {
  const orders = [{ id: 'A', quantity: 1, due: 3, machine: 'GHOST' }];
  assert.throws(() => planSchedule(orders, { M1: 5 }), { code: 'E_CAPACITY' });
});

test('due date accepts ISO date strings', () => {
  const orders = [{ id: 'A', quantity: 2, due: '1970-01-04', machine: 'M1' }];
  const plan = planSchedule(orders, { M1: 1 });
  assert.equal(plan.sequence[0].due, 3);
  assert.equal(plan.sequence[0].finish, 2);
});

// Deterministic PRNG so the property test is reproducible.
function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

test('randomized small cases match brute-force enumeration', () => {
  const rand = mulberry32(0x5eed1234);
  const pick = (n) => Math.floor(rand() * n);
  for (let iter = 0; iter < 200; iter += 1) {
    const machines = ['M1', 'M2'].slice(0, 1 + pick(2));
    const capacity = {};
    for (const m of machines) capacity[m] = 1 + pick(6);
    const n = 1 + pick(6);
    const orders = [];
    for (let i = 0; i < n; i += 1) {
      orders.push({
        id: `W${String(i)}`,
        quantity: 1 + pick(12),
        due: 1 + pick(20),
        machine: machines[pick(machines.length)],
      });
    }
    const expected = bruteForce(orders, capacity);
    if (expected === null) {
      assert.throws(() => planSchedule(orders, capacity), { code: 'E_CAPACITY' });
    } else {
      assert.deepEqual(libraryIds(orders, capacity), expected);
    }
  }
});
