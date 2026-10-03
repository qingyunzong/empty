import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tokenize } from '../src/tokenize.js';
import { verifyTokens } from '../src/verify.js';

const OPTS = { phrase: '低温 固化', material: 'M-1', equipment: 'EQ-2', maxDistance: 6 };

test('phrase must occur as consecutive tokens', () => {
  const ok = verifyTokens(tokenize('低温 固化 M-1 EQ-2'), OPTS);
  assert.equal(ok.matched, true);
  const separated = verifyTokens(tokenize('低温 加热 固化 M-1 EQ-2'), OPTS);
  assert.equal(separated.matched, false);
  assert.deepEqual(separated.phraseHits, []);
});

test('material/equipment distance boundary: 6 ok, 7 rejected', () => {
  const d6 = verifyTokens(tokenize('低温 固化 M-1 a b c d e EQ-2'), OPTS); // |2-8|=6
  assert.equal(d6.matched, true);
  assert.equal(d6.pairs.length, 1);
  assert.equal(d6.pairs[0].distance, 6);
  const d7 = verifyTokens(tokenize('低温 固化 M-1 a b c d e f EQ-2'), OPTS); // |2-9|=7
  assert.equal(d7.matched, false);
  assert.equal(d7.pairs.length, 0);
});

test('hits = phrase occurrences + qualifying pairs', () => {
  // tokens: 0:低温 1:固化 2:M-1 3:EQ-2 4..13:padding 14:M-1 15:EQ-2
  const r = verifyTokens(
    tokenize('低温 固化 M-1 EQ-2 a b c d e f g h i j M-1 EQ-2'),
    OPTS
  );
  // phrase at 0 only -> 1; pairs within 6: (2,3) and (14,15) -> 2
  assert.equal(r.phraseHits.length, 1);
  assert.equal(r.pairs.length, 2);
  assert.equal(r.hits, 3);
});

test('multiple phrase occurrences add hits', () => {
  const r = verifyTokens(tokenize('低温 固化 M-1 EQ-2 低温 固化'), OPTS);
  assert.equal(r.phraseHits.length, 2);
  assert.equal(r.pairs.length, 1);
  assert.equal(r.hits, 3);
});

test('missing material or equipment code fails', () => {
  const r = verifyTokens(tokenize('低温 固化 M-1 其他'), OPTS);
  assert.equal(r.matched, false);
});
