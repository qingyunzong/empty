'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { selectMaxSet } = require('../src/selection');

// Independent brute-force reference: enumerate every subset, keep feasible
// ones, pick max cardinality then lexicographically smallest sorted id list.
function bruteForce(candidates, available) {
  const sorted = [...candidates].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const n = sorted.length;
  let best = null;
  for (let mask = 0; mask < 1 << n; mask += 1) {
    const sums = new Map();
    const ids = [];
    for (let i = 0; i < n; i += 1) {
      if (mask & (1 << i)) {
        const c = sorted[i];
        ids.push(c.id);
        sums.set(c.account, (sums.get(c.account) || 0) + c.amount);
      }
    }
    let ok = true;
    for (const [account, sum] of sums) {
      if (sum > (available[account] ?? 0)) {
        ok = false;
        break;
      }
    }
    if (!ok) continue;
    if (best === null || ids.length > best.length || (ids.length === best.length && lexLess(ids, best))) {
      best = ids;
    }
  }
  return best || [];
}

function lexLess(a, b) {
  for (let i = 0; i < a.length; i += 1) {
    if (a[i] !== b[i]) return a[i] < b[i];
  }
  return false;
}

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

test('matches independent subset enumeration on random cases (n <= 12)', () => {
  const rand = mulberry32(20261003);
  for (let iter = 0; iter < 400; iter += 1) {
    const accountIds = Array.from({ length: 1 + Math.floor(rand() * 3) }, (_, i) => `acc${i}`);
    const n = Math.floor(rand() * 13);
    const candidates = [];
    for (let i = 0; i < n; i += 1) {
      candidates.push({
        id: `p${String(i).padStart(2, '0')}`,
        account: accountIds[Math.floor(rand() * accountIds.length)],
        amount: 1 + Math.floor(rand() * 20),
      });
    }
    const available = {};
    for (const id of accountIds) available[id] = Math.floor(rand() * 40);
    const got = selectMaxSet(candidates, available);
    const want = bruteForce(candidates, available);
    assert.deepEqual(
      got.selected,
      want,
      `iter ${iter}: ${JSON.stringify({ candidates, available })}`,
    );
    const chosen = new Set(got.selected);
    assert.deepEqual(
      got.rejected,
      candidates.map((c) => c.id).filter((id) => !chosen.has(id)).sort(),
    );
  }
});

test('random cases with heavy amount ties still match enumeration', () => {
  const rand = mulberry32(777);
  for (let iter = 0; iter < 300; iter += 1) {
    const n = 2 + Math.floor(rand() * 11);
    const amount = 1 + Math.floor(rand() * 5);
    const candidates = [];
    for (let i = 0; i < n; i += 1) {
      candidates.push({ id: `q${String(i).padStart(2, '0')}`, account: 'a', amount });
    }
    const available = { a: Math.floor(rand() * (n * amount + 1)) };
    assert.deepEqual(
      selectMaxSet(candidates, available).selected,
      bruteForce(candidates, available),
      `iter ${iter}: n=${n} amount=${amount} available=${available.a}`,
    );
  }
});

test('lexicographic tie-break among equal-count equal-amount sets', () => {
  const candidates = [
    { id: 'p3', account: 'a', amount: 10 },
    { id: 'p1', account: 'a', amount: 10 },
    { id: 'p2', account: 'a', amount: 10 },
  ];
  const result = selectMaxSet(candidates, { a: 10 });
  assert.deepEqual(result.selected, ['p1']);
  assert.deepEqual(result.rejected, ['p2', 'p3']);
});

test('larger count wins; lexicographic order breaks the remaining tie', () => {
  const candidates = [
    { id: 'p1', account: 'a', amount: 4 },
    { id: 'p2', account: 'a', amount: 6 },
    { id: 'p3', account: 'a', amount: 6 },
  ];
  // {p1,p2} and {p1,p3} are both feasible with count 2; {p1,p2} is smaller.
  const result = selectMaxSet(candidates, { a: 10 });
  assert.deepEqual(result.selected, ['p1', 'p2']);
  assert.deepEqual(result.rejected, ['p3']);
});

test('per-account budgets constrain independently', () => {
  const candidates = [
    { id: 'a1', account: 'x', amount: 5 },
    { id: 'a2', account: 'x', amount: 5 },
    { id: 'b1', account: 'y', amount: 7 },
    { id: 'b2', account: 'y', amount: 7 },
  ];
  const result = selectMaxSet(candidates, { x: 5, y: 7 });
  assert.deepEqual(result.selected, ['a1', 'b1']);
  assert.deepEqual(result.rejected, ['a2', 'b2']);
});

test('empty candidate list selects nothing', () => {
  assert.deepEqual(selectMaxSet([], { a: 10 }), { selected: [], rejected: [] });
});
