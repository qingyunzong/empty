import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Engine } from '../src/engine.js';

// Acceptance 4: empty term and cross-paragraph phrase must not hit.
test('empty phrase term raises E_TOKEN (no hits)', () => {
  const e = new Engine();
  e.addDocument('泵 气蚀 报警');
  const isToken = (err) => err.code === 'E_TOKEN';
  assert.throws(() => e.query({ phrase: '' }), isToken);
  assert.throws(() => e.query({ phrase: '   \n\n  ' }), isToken);
  assert.throws(() => e.query({}), isToken);
  assert.throws(() => e.query({ near: ['', 'a07'] }), isToken);
});

test('cross-paragraph phrase does not hit', () => {
  const e = new Engine();
  e.addDocument('泵 出口 压力 低\n\n气蚀 处理码 a07', 'cross');
  e.addDocument('泵 气蚀 处理码 a07', 'same');
  const r = e.query({ phrase: '泵 气蚀' });
  assert.deepEqual(r.map((x) => x.ext), ['same']);
});

test('cross-paragraph near pair does not hit', () => {
  const e = new Engine();
  e.addDocument('c01 入口 压力\n\na07 处理码', 'cross');
  e.addDocument('c01 a07 同段', 'same');
  const r = e.query({ near: ['c01', 'a07'], k: 4 });
  assert.deepEqual(r.map((x) => x.ext), ['same']);
});

test('phrase 泵 气蚀 ranks by hits then span then docID stably', () => {
  const e = new Engine();
  e.addDocument('泵 气蚀 泵 气蚀 泵 气蚀', 'three');   // 3 hits
  e.addDocument('x y 泵 气蚀 z', 'one');                // 1 hit
  e.addDocument('泵 气蚀', 'one-tight');                // 1 hit, span 2
  const r = e.query({ phrase: '泵 气蚀' });
  assert.deepEqual(
    r.map((x) => [x.ext, x.phraseHits, x.minSpan]),
    [['three', 3, 2], ['one', 1, 2], ['one-tight', 1, 2]]
  );
  // deterministic on repeat
  assert.deepEqual(e.query({ phrase: '泵 气蚀' }), r);
});
