'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { selectPayments } = require('../lib/selection');
const { mulberry32 } = require('./helpers');

// Independent brute-force reference: enumerate every subset, keep feasible
// ones, pick max cardinality, then lexicographically smallest sorted ID list.
function bruteForceSelect(payments, capacities) {
  const n = payments.length;
  let best = null;
  for (let mask = 0; mask < 1 << n; mask++) {
    const sums = {};
    let feasible = true;
    const ids = [];
    for (let i = 0; i < n; i++) {
      if (!(mask & (1 << i))) continue;
      const p = payments[i];
      const s = (sums[p.account] || 0) + p.amount;
      if (s > (capacities[p.account] === undefined ? 0 : capacities[p.account])) {
        feasible = false;
        break;
      }
      sums[p.account] = s;
      ids.push(p.id);
    }
    if (!feasible) continue;
    ids.sort();
    if (
      best === null ||
      ids.length > best.length ||
      (ids.length === best.length && lexCompare(ids, best) < 0)
    ) {
      best = ids;
    }
  }
  return best;
}

function lexCompare(a, b) {
  for (let i = 0; i < Math.min(a.length, b.length); i++) {
    if (a[i] !== b[i]) return a[i] < b[i] ? -1 : 1;
  }
  return a.length - b.length;
}

test('empty queue selects nothing', () => {
  const r = selectPayments([], { A: 100 });
  assert.deepEqual(r.selected, []);
  assert.deepEqual(r.rejected, []);
});

test('everything fits: select all', () => {
  const r = selectPayments(
    [
      { id: 'p2', account: 'A', amount: 10 },
      { id: 'p1', account: 'A', amount: 10 },
    ],
    { A: 100 }
  );
  assert.deepEqual(r.selected, ['p1', 'p2']);
  assert.deepEqual(r.rejected, []);
});

test('tie on count and amount: lexicographically smallest ID wins', () => {
  const payments = [
    { id: 'p3', account: 'A', amount: 30 },
    { id: 'p1', account: 'A', amount: 30 },
    { id: 'p2', account: 'A', amount: 30 },
  ];
  const r = selectPayments(payments, { A: 50 });
  assert.deepEqual(r.selected, ['p1']);
  assert.deepEqual(r.rejected, ['p2', 'p3']);
});

test('tie on count and amount, pick two of three', () => {
  const payments = [
    { id: 'a3', account: 'A', amount: 20 },
    { id: 'a2', account: 'A', amount: 20 },
    { id: 'a1', account: 'A', amount: 20 },
  ];
  const r = selectPayments(payments, { A: 40 });
  assert.deepEqual(r.selected, ['a1', 'a2']);
  assert.deepEqual(r.rejected, ['a3']);
});

test('lexicographic choice spans accounts with equal amounts', () => {
  const payments = [
    { id: 'b1', account: 'A', amount: 30 },
    { id: 'a1', account: 'A', amount: 30 },
    { id: 'a2', account: 'B', amount: 30 },
  ];
  // {a1,b1} overflows account A, so the feasible 2-sets are {a1,a2} and
  // {a2,b1}; sorted lists compare ['a1','a2'] < ['a2','b1'].
  const r = selectPayments(payments, { A: 30, B: 30 });
  assert.deepEqual(r.selected, ['a1', 'a2']);
  assert.deepEqual(r.rejected, ['b1']);
});

test('cardinality beats amount: more small payments win', () => {
  const payments = [
    { id: 'big', account: 'A', amount: 100 },
    { id: 's1', account: 'A', amount: 40 },
    { id: 's2', account: 'A', amount: 40 },
  ];
  const r = selectPayments(payments, { A: 100 });
  assert.deepEqual(r.selected, ['s1', 's2']);
  assert.deepEqual(r.rejected, ['big']);
});

test('per-account capacities are enforced independently', () => {
  const payments = [
    { id: 'z1', account: 'A', amount: 10 },
    { id: 'z2', account: 'B', amount: 10 },
    { id: 'z3', account: 'A', amount: 10 },
  ];
  const r = selectPayments(payments, { A: 10, B: 10 });
  assert.deepEqual(r.selected, ['z1', 'z2']);
  assert.deepEqual(r.rejected, ['z3']);
});

test('unknown account defaults to zero capacity', () => {
  const r = selectPayments([{ id: 'p1', account: 'ghost', amount: 5 }], {});
  assert.deepEqual(r.selected, []);
  assert.deepEqual(r.rejected, ['p1']);
});

test('randomized cross-check against brute-force enumeration (n <= 12)', () => {
  const rand = mulberry32(20261002);
  const accounts = ['A', 'B', 'C'];
  for (let iter = 0; iter < 400; iter++) {
    const n = 1 + Math.floor(rand() * 12);
    const payments = [];
    for (let i = 0; i < n; i++) {
      payments.push({
        id: 'p' + String(i).padStart(2, '0'),
        account: accounts[Math.floor(rand() * accounts.length)],
        // Heavy repetition of amounts to force many count/amount ties.
        amount: 1 + Math.floor(rand() * 6) * 5,
      });
    }
    const capacities = {};
    for (const a of accounts) capacities[a] = Math.floor(rand() * 12) * 5;
    const expected = bruteForceSelect(payments, capacities);
    const actual = selectPayments(payments, capacities);
    assert.deepEqual(
      actual.selected,
      expected,
      `iteration ${iter}: payments=${JSON.stringify(payments)} capacities=${JSON.stringify(capacities)}`
    );
    const selectedSet = new Set(actual.selected);
    const allIds = payments.map((p) => p.id).sort();
    assert.deepEqual(actual.rejected, allIds.filter((id) => !selectedSet.has(id)));
  }
});

test('deterministic: input order does not change the result', () => {
  const base = [];
  const rand = mulberry32(7);
  for (let i = 0; i < 12; i++) {
    base.push({ id: 'id' + i, account: 'acct' + (i % 3), amount: 1 + Math.floor(rand() * 20) });
  }
  const capacities = { acct0: 25, acct1: 25, acct2: 25 };
  const first = selectPayments(base, capacities);
  const shuffled = base.slice().reverse();
  const second = selectPayments(shuffled, capacities);
  assert.deepEqual(second, first);
});
