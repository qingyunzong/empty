import { test } from 'node:test';
import assert from 'node:assert/strict';
import { merge3 } from '../src/model.js';

const A = (value) => ({ tag: 'asserted', value });
const R = { tag: 'retracted' };

test('three-way merge: clean cases', () => {
  const { state, conflicts } = merge3({ k: A(1) }, { k: A(1), x: A(9) }, { k: A(2) });
  assert.deepEqual(state, { k: A(2), x: A(9) });
  assert.deepEqual(conflicts, []);
});

test('three-way merge: unknown is a value, not a failure', () => {
  // base unknown, left asserted, right unknown -> left wins cleanly
  let r = merge3({}, { k: A(1) }, {});
  assert.deepEqual(r.state, { k: A(1) });
  assert.deepEqual(r.conflicts, []);
  // base unknown, left retracted, right unknown -> retracted
  r = merge3({}, { k: R }, {});
  assert.deepEqual(r.state, { k: R });
  assert.deepEqual(r.conflicts, []);
  // both sides unknown -> stays unknown (absent)
  r = merge3({ k: A(1) }, {}, {});
  assert.deepEqual(r.state, {});
  assert.deepEqual(r.conflicts, []);
});

test('three-way merge: asserted vs retracted with asserted base conflicts', () => {
  const { conflicts } = merge3({ k: A(1) }, { k: A(2) }, { k: R });
  assert.equal(conflicts.length, 1);
  assert.equal(conflicts[0].key, 'k');
});

test('three-way merge: same change on both sides is not a conflict', () => {
  const { state, conflicts } = merge3({ k: A(1) }, { k: R }, { k: R });
  assert.deepEqual(state, { k: R });
  assert.deepEqual(conflicts, []);
});
