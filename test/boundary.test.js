import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Engine } from '../src/engine.js';

// Acceptance 1: proximity boundary k=0 / k=4 / k=5.
// gap = number of words strictly between the two codes; hit iff gap <= k.
function buildEngine() {
  const e = new Engine();
  e.addDocument('原因码 c01 a07 处理码', 'gap0');     // c01 a07 adjacent -> gap 0
  e.addDocument('原因码 c01 w1 a07 处理码', 'gap1');   // one word between -> gap 1
  e.addDocument('原因码 c01 w1 w2 w3 w4 a07 处理码', 'gap4');   // gap 4
  e.addDocument('原因码 c01 w1 w2 w3 w4 w5 a07 处理码', 'gap5');   // gap 5
  return e;
}

test('k=0 hits only adjacent codes', () => {
  const e = buildEngine();
  const r = e.query({ near: ['c01', 'a07'], k: 0 });
  assert.deepEqual(r.map((x) => x.ext), ['gap0']);
});

test('k=4 hits gap 0,1,4 but not gap 5', () => {
  const e = buildEngine();
  const r = e.query({ near: ['c01', 'a07'], k: 4 });
  assert.deepEqual(r.map((x) => x.ext).sort(), ['gap0', 'gap1', 'gap4']);
});

test('k=5 hits all including gap 5', () => {
  const e = buildEngine();
  const r = e.query({ near: ['c01', 'a07'], k: 5 });
  assert.deepEqual(r.map((x) => x.ext).sort(), ['gap0', 'gap1', 'gap4', 'gap5']);
});

test('invalid k raises E_SPAN', () => {
  const e = buildEngine();
  const isSpan = (err) => err.code === 'E_SPAN';
  assert.throws(() => e.query({ near: ['c01', 'a07'], k: -1 }), isSpan);
  assert.throws(() => e.query({ near: ['c01', 'a07'], k: 2.5 }), isSpan);
});
