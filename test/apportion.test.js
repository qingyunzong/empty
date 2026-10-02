import { test } from 'node:test';
import assert from 'node:assert/strict';
import { apportion } from '../src/apportion.js';

test('exact proportional split', () => {
  const shares = apportion(300, [
    { lineId: 'a', amount: 1000 },
    { lineId: 'b', amount: 2000 },
    { lineId: 'c', amount: 3000 },
  ]);
  assert.equal(shares.get('a'), 50);
  assert.equal(shares.get('b'), 100);
  assert.equal(shares.get('c'), 150);
});

test('remainder cents go to lines in lineId lexicographic order', () => {
  const shares = apportion(10, [
    { lineId: 'c', amount: 1 },
    { lineId: 'a', amount: 1 },
    { lineId: 'b', amount: 1 },
  ]);
  // floors are 3,3,3 -> remainder 1 -> 'a' (lexicographically first) gets it
  assert.equal(shares.get('a'), 4);
  assert.equal(shares.get('b'), 3);
  assert.equal(shares.get('c'), 3);
});

test('stable regardless of input order', () => {
  const items = [
    { lineId: 'b', amount: 7 },
    { lineId: 'a', amount: 7 },
    { lineId: 'd', amount: 3 },
    { lineId: 'c', amount: 3 },
  ];
  const first = apportion(11, items);
  const shuffled = apportion(11, [...items].reverse());
  assert.deepEqual([...first.entries()].sort(), [...shuffled.entries()].sort());
  // rerun: identical result
  assert.deepEqual([...apportion(11, items).entries()], [...first.entries()]);
});

test('zero total yields zero shares; zero weights split evenly', () => {
  const zero = apportion(0, [{ lineId: 'a', amount: 5 }]);
  assert.equal(zero.get('a'), 0);
  const even = apportion(5, [
    { lineId: 'a', amount: 0 },
    { lineId: 'b', amount: 0 },
  ]);
  assert.equal(even.get('a'), 3);
  assert.equal(even.get('b'), 2);
});

test('shares always sum to total', () => {
  for (const [total, amounts] of [
    [1, [1, 1, 1, 1, 1]],
    [999, [333, 333, 333]],
    [7, [2, 2, 2]],
  ]) {
    const shares = apportion(total, amounts.map((amount, i) => ({ lineId: `l${i}`, amount })));
    assert.equal([...shares.values()].reduce((s, v) => s + v, 0), total);
  }
});
