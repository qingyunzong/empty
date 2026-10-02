// Acceptance C: tie apportionment cross-checked against brute-force
// enumeration on small orders.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { apportion } from '../src/apportion.js';

function mulberry32(seed) {
  return function () {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function* combinations(items, k, start = 0, acc = []) {
  if (acc.length === k) {
    yield [...acc];
    return;
  }
  for (let i = start; i <= items.length - (k - acc.length); i++) {
    acc.push(items[i]);
    yield* combinations(items, k, i + 1, acc);
    acc.pop();
  }
}

const cmpTuples = (a, b) => {
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return a[i] < b[i] ? -1 : 1;
  }
  return 0;
};

// Independent reference: every line gets floor(total*amount/sum), the
// remainder cents go to the lexicographically smallest subset of lineIds.
function bruteForceApportion(total, items) {
  const sum = items.reduce((s, it) => s + it.amount, 0);
  const shares = new Map();
  if (sum <= 0) {
    const base = Math.floor(total / items.length);
    let rem = total - base * items.length;
    for (const it of [...items].sort((x, y) => (x.lineId < y.lineId ? -1 : 1))) {
      shares.set(it.lineId, base + (rem-- > 0 ? 1 : 0));
    }
    return shares;
  }
  let allocated = 0;
  for (const it of items) {
    const f = Math.floor((total * it.amount) / sum);
    shares.set(it.lineId, f);
    allocated += f;
  }
  const rem = total - allocated;
  assert.ok(rem >= 0 && rem < items.length, 'remainder within one cent per line');
  const ids = items.map((it) => it.lineId).sort();
  let best = null;
  for (const combo of combinations(ids, rem)) {
    if (!best || cmpTuples(combo, best) < 0) best = combo;
  }
  for (const id of best ?? []) shares.set(id, shares.get(id) + 1);
  return shares;
}

test('apportion matches brute-force enumeration on small random orders', () => {
  const rand = mulberry32(20261003);
  for (let iter = 0; iter < 300; iter++) {
    const n = 1 + Math.floor(rand() * 5); // 1..5 lines
    const items = [];
    for (let i = 0; i < n; i++) {
      // small amounts, many ties on purpose
      items.push({ lineId: `l${i}`, amount: Math.floor(rand() * 4) });
    }
    if (items.every((it) => it.amount === 0)) items[0].amount = 1;
    const total = Math.floor(rand() * 20);
    const expected = bruteForceApportion(total, items);
    const actual = apportion(total, items);
    assert.deepEqual(
      Object.fromEntries(actual),
      Object.fromEntries(expected),
      `mismatch for total=${total} items=${JSON.stringify(items)}`
    );
    // stability: shuffled input must not change the outcome
    const shuffled = [...items].sort(() => rand() - 0.5);
    assert.deepEqual(Object.fromEntries(apportion(total, shuffled)), Object.fromEntries(expected));
  }
});

test('equal amounts and equal tax: remainder strictly by lineId order', () => {
  // 5 lines, same amount & tax, discount remainder of 2 cents
  const items = ['e', 'd', 'c', 'b', 'a'].map((lineId) => ({ lineId, amount: 10 }));
  const shares = apportion(12, items); // floors 2 each, remainder 2
  assert.equal(shares.get('a'), 3);
  assert.equal(shares.get('b'), 3);
  assert.equal(shares.get('c'), 2);
  assert.equal(shares.get('d'), 2);
  assert.equal(shares.get('e'), 2);
});
