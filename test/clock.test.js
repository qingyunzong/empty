import { test } from 'node:test';
import assert from 'node:assert/strict';
import { clockLeq, clockEqual, dominates, compareCausality, clockMerge } from '../src/clock.js';

test('vector clock ordering', () => {
  assert.equal(clockLeq({ a: 1 }, { a: 1, b: 2 }), true);
  assert.equal(clockLeq({ a: 2 }, { a: 1, b: 2 }), false);
  assert.equal(clockEqual({ a: 1, b: 2 }, { a: 1, b: 2 }), true);
  assert.equal(dominates({ a: 2, b: 2 }, { a: 1, b: 2 }), true);
  assert.equal(dominates({ a: 1, b: 2 }, { a: 1, b: 2 }), false);
});

test('compareCausality detects concurrency', () => {
  assert.equal(compareCausality({ a: 1 }, { a: 2 }), -1);
  assert.equal(compareCausality({ a: 2 }, { a: 1 }), 1);
  assert.equal(compareCausality({ a: 1 }, { a: 1 }), 0);
  assert.equal(compareCausality({ a: 2, b: 1 }, { a: 1, b: 2 }), 2);
});

test('clockMerge takes componentwise max', () => {
  assert.deepEqual(clockMerge({ a: 2, b: 1 }, { a: 1, c: 5 }), { a: 2, b: 1, c: 5 });
});
