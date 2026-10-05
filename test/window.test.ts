import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  addEvent,
  correctEvent,
  createWindow,
  quantile,
  removeEvent,
  size,
  toSortedArray,
} from '../src/window.js';
import { ModelWindow } from '../src/model.js';
import { rng, randInt } from './helpers.js';

test('fixed-size window evicts oldest; duplicates and deletion by event id', () => {
  let s = createWindow(3);
  s = addEvent(s, 1, 10);
  s = addEvent(s, 2, 20);
  s = addEvent(s, 3, 20); // duplicate value
  s = addEvent(s, 4, 5); // evicts event 1 (value 10)
  assert.deepEqual(toSortedArray(s), [5, 20, 20]);
  assert.equal(quantile(s, 0, 1), 5); // p = 0 -> minimum
  assert.equal(quantile(s, 1, 1), 20); // p = 1 -> maximum
  s = removeEvent(s, 2); // delete one of the two 20s
  assert.deepEqual(toSortedArray(s), [5, 20]);
  s = removeEvent(s, 99); // unknown id: no-op
  assert.deepEqual(toSortedArray(s), [5, 20]);
  assert.equal(size(s), 2);
});

test('event id correction replaces the value in place', () => {
  let s = createWindow(4);
  s = addEvent(s, 1, 3);
  s = addEvent(s, 2, 8);
  s = addEvent(s, 3, 8);
  const before = s;
  s = correctEvent(s, 2, 30);
  assert.deepEqual(toSortedArray(s), [3, 8, 30]);
  assert.equal(quantile(s, 1, 1), 30);
  // Old snapshot is untouched and still readable.
  assert.deepEqual(toSortedArray(before), [3, 8, 8]);
  assert.equal(quantile(before, 1, 1), 8);
  // Correcting an unknown or evicted event is a no-op.
  assert.equal(correctEvent(s, 42, 1), s);
  // No-op correction returns the identical state.
  assert.equal(correctEvent(s, 1, 3), s);
});

test('empty window returns empty (null) for any quantile', () => {
  let s = createWindow(2);
  assert.equal(quantile(s, 0, 1), null);
  assert.equal(quantile(s, 1, 2), null);
  assert.equal(quantile(s, 1, 1), null);
  s = addEvent(s, 1, 7);
  s = removeEvent(s, 1);
  assert.equal(quantile(s, 1, 2), null);
});

test('rational p sweep matches the sorted model for n = 1..12', () => {
  const ps: [number, number][] = [
    [0, 1],
    [1, 10],
    [1, 4],
    [1, 3],
    [1, 2],
    [2, 3],
    [3, 4],
    [9, 10],
    [1, 1],
  ];
  let s = createWindow(16);
  const model = new ModelWindow(16);
  for (let n = 1; n <= 12; n++) {
    s = addEvent(s, n, (n * 37) % 11); // values with duplicates
    model.add(n, (n * 37) % 11);
    for (const [num, den] of ps) {
      assert.equal(quantile(s, num, den), model.quantile(num, den), `n=${n} p=${num}/${den}`);
    }
  }
});

test('per-step sorted check of sliding window with adds, deletes, corrections', () => {
  const rand = rng(1234);
  const capacity = 8;
  let s = createWindow(capacity);
  const model = new ModelWindow(capacity);
  const liveQueue: number[] = []; // ids currently in the window, oldest first
  let nextId = 1;
  const ps: [number, number][] = [
    [0, 1],
    [1, 2],
    [1, 1],
  ];
  for (let step = 0; step < 2000; step++) {
    const roll = rand();
    if (roll < 0.5 || liveQueue.length === 0) {
      const id = nextId++;
      const value = randInt(rand, 0, 30);
      s = addEvent(s, id, value);
      model.add(id, value);
      if (liveQueue.length === capacity) liveQueue.shift(); // evicted
      liveQueue.push(id);
    } else if (roll < 0.75) {
      const id = liveQueue[randInt(rand, 0, liveQueue.length - 1)];
      s = removeEvent(s, id);
      model.remove(id);
      liveQueue.splice(liveQueue.indexOf(id), 1);
    } else {
      const id = liveQueue[randInt(rand, 0, liveQueue.length - 1)];
      const value = randInt(rand, 0, 30);
      s = correctEvent(s, id, value);
      model.correct(id, value);
    }
    // Per-step verification: full sorted contents + extreme and middle quantiles.
    assert.deepEqual(toSortedArray(s), model.toSortedArray(), `step ${step}: sorted`);
    for (const [num, den] of ps) {
      assert.equal(quantile(s, num, den), model.quantile(num, den), `step ${step} p=${num}/${den}`);
    }
  }
});
