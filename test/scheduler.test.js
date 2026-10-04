import test from 'node:test';
import assert from 'node:assert/strict';
import { planSchedule, orderLoad } from '../src/scheduler.js';

const CAPACITY = 8;
const ORDERS = [
  { id: 'W03', quantity: 2, dueDate: '2026-10-05', capability: 3 },
  { id: 'W01', quantity: 1, dueDate: '2026-10-05', capability: 2 },
  { id: 'W05', quantity: 4, dueDate: '2026-10-03', capability: 1 },
  { id: 'W02', quantity: 1, dueDate: '2026-10-04', capability: 8 },
  { id: 'W04', quantity: 3, dueDate: '2026-10-03', capability: 2 },
];

function* permutations(items) {
  if (items.length <= 1) { yield items.slice(); return; }
  for (let i = 0; i < items.length; i++) {
    const rest = items.slice(0, i).concat(items.slice(i + 1));
    for (const p of permutations(rest)) yield [items[i], ...p];
  }
}

function feasible(perm, capacity) {
  // Greedy day packing never strands an order iff each fits in one day.
  return perm.every((o) => orderLoad(o) <= capacity);
}

function comparePermutations(a, b) {
  for (let i = 0; i < a.length; i++) {
    if (a[i].dueDate !== b[i].dueDate) return a[i].dueDate < b[i].dueDate ? -1 : 1;
    if (a[i].id !== b[i].id) return a[i].id < b[i].id ? -1 : 1;
  }
  return 0;
}

function referenceSchedule(orders, capacity) {
  let best = null;
  for (const perm of permutations(orders)) {
    if (!feasible(perm, capacity)) continue;
    if (best === null || comparePermutations(perm, best) < 0) best = perm;
  }
  if (best === null) return null;
  const days = [];
  let current = { day: 1, orders: [], load: 0 };
  for (const o of best) {
    const load = orderLoad(o);
    if (current.orders.length > 0 && current.load + load > capacity) {
      days.push(current);
      current = { day: current.day + 1, orders: [], load: 0 };
    }
    current.orders.push(o.id);
    current.load += load;
  }
  if (current.orders.length > 0) days.push(current);
  return { order: best.map((o) => o.id), days };
}

test('5-order schedule matches brute-force enumeration of all permutations', () => {
  const expected = referenceSchedule(ORDERS, CAPACITY);
  assert.ok(expected, 'reference found a feasible permutation');
  const actual = planSchedule(ORDERS, CAPACITY);
  assert.deepEqual(actual.order, expected.order);
  assert.deepEqual(actual.days, expected.days);
  assert.equal(actual.totalLoad, ORDERS.reduce((s, o) => s + orderLoad(o), 0));
});

test('no day exceeds daily capacity', () => {
  const { days } = planSchedule(ORDERS, CAPACITY);
  for (const d of days) assert.ok(d.load <= CAPACITY, `day ${d.day} load ${d.load}`);
});

test('order exceeding daily capacity yields E_CAPACITY', () => {
  const orders = [{ id: 'BIG', quantity: 3, dueDate: '2026-10-01', capability: 5 }];
  assert.throws(() => planSchedule(orders, 10), (err) => {
    assert.equal(err.code, 'E_CAPACITY');
    assert.deepEqual(err.orders, ['BIG']);
    return true;
  });
});

test('empty order set schedules to nothing', () => {
  const s = planSchedule([], CAPACITY);
  assert.deepEqual(s.order, []);
  assert.deepEqual(s.days, []);
  assert.equal(s.totalLoad, 0);
});
