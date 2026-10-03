import test from 'node:test';
import assert from 'node:assert/strict';
import { selectSettleable, netDeltas, withinBudget, compareIdLists } from '../src/selection.js';

function lexLess(a, b) {
  return compareIdLists(a, b) < 0;
}

// Independent brute force: enumerate every subset, keep feasible ones,
// then take max cardinality and lexicographically smallest sorted id list.
function bruteForce(pending, budgets, base = {}) {
  const sorted = [...pending].sort((a, b) => (a.id < b.id ? -1 : 1));
  const feasible = [];
  const walk = (i, ids, deltas) => {
    if (i === sorted.length) {
      if (withinBudget(deltas, budgets, base)) feasible.push(ids);
      return;
    }
    walk(i + 1, ids, deltas);
    const t = sorted[i];
    const next = { ...deltas };
    next[t.from] = (next[t.from] ?? 0) + t.amount;
    next[t.to] = (next[t.to] ?? 0) - t.amount;
    walk(i + 1, [...ids, t.id], next);
  };
  walk(0, [], {});
  const maxSize = Math.max(0, ...feasible.map((f) => f.length));
  return feasible.filter((f) => f.length === maxSize).sort(compareIdLists)[0] ?? [];
}

function mulberry32(seed) {
  let a = seed;
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

test('netDeltas nets outgoing minus incoming per participant', () => {
  const deltas = netDeltas([
    { id: 't1', from: 'a', to: 'b', amount: 10 },
    { id: 't2', from: 'b', to: 'a', amount: 3 },
  ]);
  assert.deepEqual(deltas, { a: 7, b: -7 });
});

test('tie on max cardinality picks lexicographically smallest id sequence', () => {
  const budgets = { alice: 20 };
  const pending = [
    { id: 't1', from: 'alice', to: 'bob', amount: 10 },
    { id: 't2', from: 'alice', to: 'carol', amount: 10 },
    { id: 't3', from: 'alice', to: 'bob', amount: 10 },
  ];
  const selected = selectSettleable(pending, budgets);
  assert.deepEqual(selected.map((t) => t.id), ['t1', 't2']);
});

test('lexicographically smaller infeasible set is skipped', () => {
  const budgets = { alice: 15 };
  const pending = [
    { id: 't1', from: 'alice', to: 'bob', amount: 15 },
    { id: 't2', from: 'alice', to: 'bob', amount: 5 },
    { id: 't3', from: 'alice', to: 'carol', amount: 5 },
  ];
  const selected = selectSettleable(pending, budgets);
  assert.deepEqual(selected.map((t) => t.id), ['t2', 't3']);
});

test('retained budget base limits further settlement', () => {
  const budgets = { alice: 18 };
  const base = { alice: 12 };
  const pending = [
    { id: 't1', from: 'alice', to: 'bob', amount: 10 },
    { id: 't2', from: 'alice', to: 'bob', amount: 5 },
    { id: 't3', from: 'alice', to: 'carol', amount: 5 },
  ];
  const selected = selectSettleable(pending, budgets, base);
  assert.deepEqual(selected.map((t) => t.id), ['t2']);
});

test('matches brute force on randomized cases', () => {
  const rand = mulberry32(42);
  const parties = ['a', 'b', 'c'];
  for (let iter = 0; iter < 100; iter += 1) {
    const n = 2 + Math.floor(rand() * 7); // 2..8 transfers
    const pending = [];
    for (let i = 0; i < n; i += 1) {
      const from = parties[Math.floor(rand() * parties.length)];
      let to = parties[Math.floor(rand() * parties.length)];
      if (to === from) to = parties[(parties.indexOf(from) + 1) % parties.length];
      pending.push({ id: `t${i + 1}`, from, to, amount: 1 + Math.floor(rand() * 10) });
    }
    const budgets = {};
    for (const p of parties) budgets[p] = Math.floor(rand() * 25);
    const base = {};
    for (const p of parties) if (rand() < 0.3) base[p] = Math.floor(rand() * 5);
    const got = selectSettleable(pending, budgets, base).map((t) => t.id);
    const want = bruteForce(pending, budgets, base);
    assert.deepEqual(got, want, `case ${iter}: ${JSON.stringify({ pending, budgets, base })}`);
  }
});
