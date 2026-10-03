import test from 'node:test';
import assert from 'node:assert/strict';
import { compareVclock, isConcurrent, dominates, mergeVclock } from '../src/vclock.js';

test('compareVclock: equal, before, after', () => {
  assert.equal(compareVclock({ a: 1 }, { a: 1 }), 'eq');
  assert.equal(compareVclock({ a: 1 }, { a: 2 }), 'lt');
  assert.equal(compareVclock({ a: 2, b: 1 }, { a: 1, b: 1 }), 'gt');
  assert.equal(compareVclock({}, {}), 'eq');
  assert.equal(compareVclock({}, { a: 1 }), 'lt');
});

test('compareVclock: concurrent histories are detected', () => {
  const a = { n1: 2, n2: 1 };
  const b = { n1: 1, n2: 3 };
  assert.equal(compareVclock(a, b), 'concurrent');
  assert.equal(compareVclock(b, a), 'concurrent');
  assert.ok(isConcurrent(a, b));
  assert.ok(!isConcurrent({ a: 1 }, { a: 2 }));
});

test('dominates: causal coverage', () => {
  assert.ok(dominates({ a: 2, b: 1 }, { a: 1, b: 1 }));
  assert.ok(dominates({ a: 1 }, { a: 1 }));
  assert.ok(!dominates({ a: 1 }, { a: 2 }));
  assert.ok(!dominates({ a: 1, b: 2 }, { a: 2, b: 1 }));
});

test('mergeVclock: commutative, associative, idempotent', () => {
  const a = { x: 1, y: 3 };
  const b = { x: 2, z: 1 };
  const c = { y: 1, z: 5 };
  assert.deepEqual(mergeVclock(a, b), mergeVclock(b, a));
  assert.deepEqual(mergeVclock(mergeVclock(a, b), c), mergeVclock(a, mergeVclock(b, c)));
  assert.deepEqual(mergeVclock(a, a), a);
  assert.deepEqual(mergeVclock(a, b, c), { x: 2, y: 3, z: 5 });
});
