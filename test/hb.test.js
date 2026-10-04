import { test } from 'node:test';
import assert from 'node:assert/strict';
import { HbGraph } from '../src/hb.js';
import { batch, assertOp } from './helpers.js';

test('happens-before: deps chain is transitive', () => {
  const b1 = batch('b1', 'p1', 1, [assertOp('a', 1)]);
  const b2 = batch('b2', 'p2', 1, [assertOp('b', 2)], { deps: ['b1'] });
  const b3 = batch('b3', 'p3', 1, [assertOp('c', 3)], { deps: ['b2'] });
  const hb = new HbGraph([b1, b2, b3]);
  assert.equal(hb.compare('b1', 'b3'), 'before');
  assert.equal(hb.compare('b3', 'b1'), 'after');
});

test('happens-before: same pid ordered by logical clock', () => {
  const b1 = batch('b1', 'p1', 1, [assertOp('a', 1)]);
  const b2 = batch('b2', 'p1', 2, [assertOp('a', 2)]);
  const hb = new HbGraph([b1, b2]);
  assert.equal(hb.compare('b1', 'b2'), 'before');
});

test('happens-before: incomparable batches are concurrent', () => {
  const b1 = batch('b1', 'p1', 1, [assertOp('a', 1)]);
  const b2 = batch('b2', 'p2', 1, [assertOp('a', 2)]);
  const hb = new HbGraph([b1, b2]);
  assert.equal(hb.compare('b1', 'b2'), 'concurrent');
  assert.equal(hb.compare('b2', 'b1'), 'concurrent');
});
