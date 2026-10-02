import { test } from 'node:test';
import assert from 'node:assert/strict';
import { allocate } from '../src/allocation.js';

test('tie-break: equal amounts split remainder by lineId lexicographic order', () => {
  const r = allocate(4, [{ lineId: 'l3', amount: 100 }, { lineId: 'l1', amount: 100 }, { lineId: 'l2', amount: 100 }]);
  assert.deepEqual([...r.entries()].sort(), [['l1', 2], ['l2', 1], ['l3', 1]]);
});

test('tie-break: single remainder unit goes to lexicographically smallest lineId', () => {
  const r = allocate(1, [{ lineId: 'b', amount: 50 }, { lineId: 'a', amount: 50 }]);
  assert.equal(r.get('a'), 1);
  assert.equal(r.get('b'), 0);
});

test('stability: result is identical for every input permutation', () => {
  const base = [
    { lineId: 'l1', amount: 100 },
    { lineId: 'l2', amount: 100 },
    { lineId: 'l3', amount: 300 },
    { lineId: 'l4', amount: 100 },
  ];
  const expected = allocate(10, base);
  const permute = (arr) => arr.flatMap((x, i) => i === arr.length ? [[]] : permute(arr.slice(0, i).concat(arr.slice(i + 1))).map((p) => [x, ...p]), );
  for (const p of permute(base)) {
    assert.deepEqual(allocate(10, p), expected);
  }
});

// Acceptance C: cross-check tie allocation against brute-force enumeration.
// For small orders, enumerate every candidate remainder-receiver subset S of
// size R and keep the ones consistent with the rule "largest remainder, ties
// by lineId asc". The rule must select exactly one subset, equal to allocate().
test('brute-force cross-check on small orders', () => {
  const subsets = (arr, k, start = 0, acc = [], out = []) => {
    if (acc.length === k) { out.push([...acc]); return out; }
    for (let i = start; i < arr.length; i++) { acc.push(arr[i]); subsets(arr, k, i + 1, acc, out); acc.pop(); }
    return out;
  };
  let checked = 0;
  const combos = (n, acc = [], out = []) => {
    if (acc.length === n) { out.push([...acc]); return out; }
    for (const v of [0, 3, 6]) { acc.push(v); combos(n, acc, out); acc.pop(); }
    return out;
  };
  for (let n = 2; n <= 4; n++) {
    const lineIds = ['l1', 'l2', 'l3', 'l4'].slice(0, n);
    for (const amounts of combos(n)) {
      const sum = amounts.reduce((x, y) => x + y, 0);
      if (sum === 0) continue;
      for (let total = 0; total <= 8; total++) {
        const entries = lineIds.map((lineId, i) => ({ lineId, amount: amounts[i] }));
        const got = allocate(total, entries);
        // invariants: sum preserved, each share is floor or ceil of exact share
        assert.equal([...got.values()].reduce((x, y) => x + y, 0), total);
        const rows = entries.map((e) => {
          const num = total * e.amount;
          return { lineId: e.lineId, q: Math.floor(num / sum), r: num % sum };
        });
        for (const row of rows) {
          const v = got.get(row.lineId);
          assert.ok(v === row.q || v === row.q + 1, `${row.lineId}: ${v} not in [${row.q}, ${row.q + 1}]`);
        }
        // brute force: which subsets of ceil-receivers satisfy the rule?
        const rem = total - rows.reduce((x, y) => x + y.q, 0);
        const valid = subsets(rows, rem).filter((S) => {
          const inS = new Set(S.map((x) => x.lineId));
          return rows.every((j) => inS.has(j.lineId) || S.every((i) => i.r > j.r || (i.r === j.r && i.lineId < j.lineId)));
        });
        assert.equal(valid.length, 1, `rule must select exactly one subset (total=${total}, amounts=${amounts})`);
        const expectedCeil = new Set(valid[0].map((x) => x.lineId));
        for (const row of rows) {
          assert.equal(got.get(row.lineId), row.q + (expectedCeil.has(row.lineId) ? 1 : 0));
        }
        checked++;
      }
    }
  }
  assert.ok(checked > 1000, `expected substantial brute-force coverage, got ${checked}`);
});

test('zero-amount lines fall back to equal split with lineId tie-break', () => {
  const r = allocate(5, [{ lineId: 'b', amount: 0 }, { lineId: 'a', amount: 0 }]);
  assert.equal(r.get('a'), 3);
  assert.equal(r.get('b'), 2);
});
