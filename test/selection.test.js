'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { selectSettleable, compareIdSeq } = require('../src/selection');
const { BusinessError } = require('../src/errors');

// Independent reference: recursive enumeration of every subset.
function referenceSelect(transfers, budgets) {
  let best = null;
  const chosen = [];
  function feasible() {
    const net = {};
    for (const t of chosen) {
      net[t.from] = (net[t.from] || 0) + t.amount;
      net[t.to] = (net[t.to] || 0) - t.amount;
    }
    return Object.entries(net).every(([p, v]) => v <= (budgets[p] === undefined ? Infinity : budgets[p]));
  }
  function consider() {
    if (!feasible()) return;
    const ids = chosen.map((t) => t.id).sort();
    if (
      best === null ||
      ids.length > best.length ||
      (ids.length === best.length && compareIdSeq(ids, best) < 0)
    ) {
      best = ids;
    }
  }
  function walk(i) {
    if (i === transfers.length) {
      consider();
      return;
    }
    walk(i + 1);
    chosen.push(transfers[i]);
    walk(i + 1);
    chosen.pop();
  }
  walk(0);
  return best;
}

test('empty candidate set settles nothing', () => {
  assert.deepEqual(selectSettleable([], {}), []);
});

test('single transfer within budget settles', () => {
  assert.deepEqual(
    selectSettleable([{ id: 't1', from: 'A', to: 'B', amount: 10 }], { A: 10 }),
    ['t1']
  );
});

test('single transfer over budget does not settle', () => {
  assert.deepEqual(
    selectSettleable([{ id: 't1', from: 'A', to: 'B', amount: 11 }], { A: 10 }),
    []
  );
});

test('max cardinality wins over lexicographic order', () => {
  const transfers = [
    { id: 'a1', from: 'A', to: 'B', amount: 5 },
    { id: 'a2', from: 'A', to: 'C', amount: 5 },
    { id: 'a3', from: 'A', to: 'D', amount: 9 },
  ];
  // budget 10: {a1,a2} (2 transfers) beats {a3} alone etc.
  assert.deepEqual(selectSettleable(transfers, { A: 10 }), ['a1', 'a2']);
});

test('lexicographically smallest id sequence wins among equal maxima', () => {
  const transfers = [
    { id: 't2', from: 'A', to: 'B', amount: 5 },
    { id: 't1', from: 'A', to: 'C', amount: 5 },
  ];
  // Both singletons feasible and equal size; t1 < t2.
  assert.deepEqual(selectSettleable(transfers, { A: 5 }), ['t1']);
});

test('lexicographic tie-break compares element-wise on sorted ids', () => {
  const transfers = [
    { id: 't1', from: 'A', to: 'X', amount: 3 },
    { id: 't2', from: 'A', to: 'Y', amount: 3 },
    { id: 't3', from: 'B', to: 'Z', amount: 3 },
  ];
  // budget A=3, B=3: feasible pairs are {t1,t3} and {t2,t3}; pick [t1,t3].
  assert.deepEqual(selectSettleable(transfers, { A: 3, B: 3 }), ['t1', 't3']);
});

test('net receivers relax the payer constraint', () => {
  const transfers = [
    { id: 't1', from: 'A', to: 'B', amount: 100 },
    { id: 't2', from: 'B', to: 'C', amount: 60 },
  ];
  // A net 100 <= 100, B net 40 <= 40.
  assert.deepEqual(selectSettleable(transfers, { A: 100, B: 40 }), ['t1', 't2']);
});

test('rejects more than 10 transfers', () => {
  const transfers = Array.from({ length: 11 }, (_, i) => ({
    id: `t${i}`,
    from: 'A',
    to: 'B',
    amount: 1,
  }));
  assert.throws(() => selectSettleable(transfers, {}), BusinessError);
});

test('matches independent brute-force reference on randomized cases', () => {
  let seed = 123456789;
  const rand = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
  const parties = ['A', 'B', 'C', 'D'];
  for (let iter = 0; iter < 200; iter++) {
    const n = 1 + Math.floor(rand() * 8);
    const transfers = [];
    for (let i = 0; i < n; i++) {
      let from = parties[Math.floor(rand() * parties.length)];
      let to = parties[Math.floor(rand() * parties.length)];
      while (to === from) to = parties[Math.floor(rand() * parties.length)];
      transfers.push({ id: `t${i}`, from, to, amount: 1 + Math.floor(rand() * 50) });
    }
    const budgets = {};
    for (const p of parties) {
      budgets[p] = Math.floor(rand() * 120);
    }
    assert.deepEqual(
      selectSettleable(transfers, budgets),
      referenceSelect(transfers, budgets),
      `iter=${iter} transfers=${JSON.stringify(transfers)} budgets=${JSON.stringify(budgets)}`
    );
  }
});
