import { test } from 'node:test';
import assert from 'node:assert/strict';
import { matchPred, matchWhere, applyExpect } from '../src/algebra.js';
import { canonical, hashValue } from '../src/canonical.js';

test('predicates: comparison ops', () => {
  const row = { a: 5, s: 'x', arr: [1, 2] };
  assert.equal(matchPred(row, { field: 'a', op: 'eq', value: 5 }), true);
  assert.equal(matchPred(row, { field: 'a', op: 'ne', value: 5 }), false);
  assert.equal(matchPred(row, { field: 'a', op: 'lt', value: 6 }), true);
  assert.equal(matchPred(row, { field: 'a', op: 'lte', value: 5 }), true);
  assert.equal(matchPred(row, { field: 'a', op: 'gt', value: 4 }), true);
  assert.equal(matchPred(row, { field: 'a', op: 'gte', value: 6 }), false);
  assert.equal(matchPred(row, { field: 's', op: 'in', value: ['x', 'y'] }), true);
  assert.equal(matchPred(row, { field: 's', op: 'in', value: ['z'] }), false);
});

test('predicates: NULL field never matches except exists', () => {
  const row = { a: null };
  for (const op of ['eq', 'ne', 'lt', 'lte', 'gt', 'gte', 'in']) {
    assert.equal(matchPred(row, { field: 'a', op, value: 1 }), false, op);
    assert.equal(matchPred(row, { field: 'missing', op, value: 1 }), false, `missing ${op}`);
  }
  assert.equal(matchPred(row, { field: 'a', op: 'exists' }), false);
  assert.equal(matchPred(row, { field: 'a', op: 'exists', value: false }), true);
  assert.equal(matchPred({ a: 1 }, { field: 'a', op: 'exists' }), true);
});

test('where is a conjunction', () => {
  const row = { a: 5, b: 'x' };
  assert.equal(matchWhere(row, [
    { field: 'a', op: 'gte', value: 5 },
    { field: 'b', op: 'eq', value: 'x' },
  ]), true);
  assert.equal(matchWhere(row, [
    { field: 'a', op: 'gte', value: 5 },
    { field: 'b', op: 'eq', value: 'y' },
  ]), false);
});

test('expect: NULL aggregate value is unknown, never false', () => {
  assert.equal(applyExpect('gte', null, 3), 'unknown');
  assert.equal(applyExpect('lt', null, 3), 'unknown');
  assert.equal(applyExpect('gte', 3, 3), true);
  assert.equal(applyExpect('lt', 3, 3), false);
});

test('canonical json is key-order independent', () => {
  const a = { x: 1, y: { b: 2, a: [3, { z: 1, m: 2 }] } };
  const b = { y: { a: [3, { m: 2, z: 1 }], b: 2 }, x: 1 };
  assert.equal(canonical(a), canonical(b));
  assert.equal(hashValue(a), hashValue(b));
  assert.notEqual(hashValue(a), hashValue({ ...a, x: 2 }));
});
