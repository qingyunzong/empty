'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { applyOps } = require('../src/index.js');

// Enumerate every merge order for n concurrent ops (n <= 8) and check that
// all legal merge results coincide: same final inventory, empty pending.
function* permutations(arr) {
  if (arr.length <= 1) { yield arr.slice(); return; }
  for (let i = 0; i < arr.length; i++) {
    const rest = arr.slice(0, i).concat(arr.slice(i + 1));
    for (const p of permutations(rest)) yield [arr[i], ...p];
  }
}

function factorial(n) { return n <= 1 ? 1 : n * factorial(n - 1); }

// Deltas chosen so the aggregate is non-negative but many prefixes go negative
// (forcing the pending/defer path), from a small initial stock.
const DELTAS = [3, -2, 1, -4, 5, -3, 2, -1];
const INITIAL = 2;

test('n<=8: all merge orders converge to the single legal result', (t) => {
  for (let n = 1; n <= 8; n++) {
    const deltas = DELTAS.slice(0, n);
    const expected = INITIAL + deltas.reduce((s, d) => s + d, 0);
    assert.ok(expected >= 0, `fixture broken at n=${n}`);
    const ops = deltas.map((delta, i) => ({ opId: `N${i}#1`, node: `N${i}`, seq: 1, bin: 'A-01', item: 'ITM-0001', delta }));
    const outcomes = new Set();
    let count = 0;
    for (const order of permutations(ops)) {
      const inventory = { 'A-01|ITM-0001': INITIAL };
      const res = applyOps(inventory, order);
      assert.equal(res.pending.length, 0, `order ${order.map((o) => o.opId)} left pending`);
      outcomes.add(JSON.stringify(inventory));
      count++;
    }
    assert.equal(count, factorial(n));
    assert.equal(outcomes.size, 1, `n=${n}: divergent merge results: ${[...outcomes]}`);
    assert.equal(JSON.parse([...outcomes][0])['A-01|ITM-0001'], expected);
    t.diagnostic(`n=${n}: ${count} orders -> 1 legal result (qty=${expected})`);
  }
});

test('n<=8: genuinely negative aggregates stay pending in every order (never fail, never negative)', (t) => {
  for (let n = 2; n <= 8; n++) {
    const deltas = DELTAS.slice(0, n).concat([-100]); // aggregate forced negative
    const ops = deltas.map((delta, i) => ({ opId: `M${i}#1`, node: `M${i}`, seq: 1, bin: 'A-01', item: 'ITM-0001', delta }));
    // enumerate orders of the first n ops with the -100 inserted at each position
    for (const order of permutations(ops.slice(0, n))) {
      for (let pos = 0; pos <= n; pos++) {
        const full = order.slice(0, pos).concat([ops[n]], order.slice(pos));
        const inventory = { 'A-01|ITM-0001': INITIAL };
        const res = applyOps(inventory, full);
        assert.equal(res.pending.length, 1);
        assert.equal(res.pending[0].delta, -100);
        assert.ok(inventory['A-01|ITM-0001'] >= 0, 'inventory must never go negative');
        assert.equal(inventory['A-01|ITM-0001'], INITIAL + DELTAS.slice(0, n).reduce((s, d) => s + d, 0));
      }
    }
    t.diagnostic(`n=${n}: ${factorial(n) * (n + 1)} orders -> -100 always pending`);
  }
});
