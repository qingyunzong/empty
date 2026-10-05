import { test } from 'node:test';
import assert from 'node:assert/strict';
import { countLess, countOf, insert, remove, select, sizeOf, toArray } from '../src/treap.js';
import { quantileRank } from '../src/quantile.js';
import { SortedList } from '../src/model.js';
import { rng, randInt } from './helpers.js';
import type { Node } from '../src/treap.js';

test('quantile rank rule: ceil(p*n), p=0 clamps to minimum rank', () => {
  assert.equal(quantileRank(0, 1, 10), 1); // p = 0 -> minimum
  assert.equal(quantileRank(1, 1, 10), 10); // p = 1 -> maximum
  assert.equal(quantileRank(1, 2, 10), 5);
  assert.equal(quantileRank(1, 2, 9), 5); // ceil(4.5)
  assert.equal(quantileRank(1, 3, 10), 4); // ceil(10/3)
  assert.equal(quantileRank(2, 3, 10), 7); // ceil(20/3)
  assert.equal(quantileRank(99, 100, 7), 7); // ceil(6.93)
  assert.equal(quantileRank(1, 1000, 1), 1);
  assert.throws(() => quantileRank(3, 2, 5)); // p > 1 rejected
  assert.throws(() => quantileRank(1, 0, 5)); // zero denominator rejected
  assert.throws(() => quantileRank(1, 2, 0)); // empty rejected
});

test('per-step sorted check: extreme ranks and heavy duplicates', () => {
  const rand = rng(20261005);
  let root: Node | undefined;
  const model = new SortedList();
  const steps = 4000;
  for (let step = 0; step < steps; step++) {
    // Small value pool forces many duplicates.
    const value = randInt(rand, 0, 15);
    if (model.size() === 0 || rand() < 0.6) {
      root = insert(root, value);
      model.insert(value);
    } else {
      const victim = model.at(randInt(rand, 0, model.size() - 1));
      root = remove(root, victim);
      model.removeOne(victim);
    }
    // Per-step check against the plainly sorted model.
    assert.deepEqual(toArray(root), model.toArray(), `step ${step}: sorted contents`);
    const n = sizeOf(root);
    assert.equal(n, model.size(), `step ${step}: size`);
    if (n > 0) {
      assert.equal(select(root!, 1), model.at(0), `step ${step}: extreme rank 1 (min)`);
      assert.equal(select(root!, n), model.at(n - 1), `step ${step}: extreme rank n (max)`);
      const rank = randInt(rand, 1, n);
      assert.equal(select(root!, rank), model.at(rank - 1), `step ${step}: rank ${rank}`);
      const probe = randInt(rand, -1, 16);
      assert.equal(countLess(root, probe), model.countLess(probe), `step ${step}: countLess(${probe})`);
      assert.equal(countOf(root, value), model.toArray().filter((x) => x === value).length);
    }
  }
});

test('persistence: old roots stay valid after later mutations', () => {
  const rand = rng(7);
  const snapshots: { root: Node | undefined; sorted: number[] }[] = [];
  let root: Node | undefined;
  const model = new SortedList();
  for (let i = 0; i < 300; i++) {
    const value = randInt(rand, 0, 50);
    if (model.size() === 0 || rand() < 0.5) {
      root = insert(root, value);
      model.insert(value);
    } else {
      const victim = model.at(randInt(rand, 0, model.size() - 1));
      root = remove(root, victim);
      model.removeOne(victim);
    }
    snapshots.push({ root, sorted: model.toArray() });
  }
  // Every historical root still answers exactly as when it was taken.
  for (const snap of snapshots) {
    assert.deepEqual(toArray(snap.root), snap.sorted);
    const n = snap.sorted.length;
    if (n > 0) {
      assert.equal(select(snap.root!, 1), snap.sorted[0]);
      assert.equal(select(snap.root!, n), snap.sorted[n - 1]);
    }
  }
});
