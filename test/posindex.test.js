import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  tokenize,
  encodeVarints,
  decodeVarints,
  encodePostings,
  decodePostings,
  PositionalIndex,
} from '../src/posindex.js';
import { brutePhraseAll, bruteNearAll } from '../testlib/helpers.js';

test('tokenize splits latin, digits and CJK, lowercases', () => {
  assert.deepEqual(tokenize('Fixed Rate 3.5% 债券'), ['fixed', 'rate', '3', '5', '债', '券']);
  assert.deepEqual(tokenize(''), []);
  assert.deepEqual(tokenize(null), []);
});

test('varint round-trip including multi-byte values', () => {
  const nums = [0, 1, 127, 128, 300, 16384, 2 ** 20, 5];
  const buf = encodeVarints(nums);
  const { values, offset } = decodeVarints(buf, nums.length);
  assert.deepEqual(values, nums);
  assert.equal(offset, buf.length);
});

test('postings compression round-trip', () => {
  const postings = new Map([
    ['alpha', new Map([[0, [1, 2, 5]], [3, [0, 300]]])],
    ['债', new Map([[2, [7]]])],
  ]);
  const decoded = decodePostings(encodePostings(postings));
  assert.deepEqual(decoded, postings);
});

const DOCS = [
  ['n1', 'the quick brown fox jumps over the lazy dog'],
  ['n2', 'fixed rate bond with fixed coupon and quarterly payment'],
  ['n3', 'the fixed rate note matures in five years'],
  ['n4', '利率 固定 债券 每年 付息'],
  ['n5', 'unrelated text about equity markets and nothing else'],
];

function buildIndex(docs = DOCS) {
  const index = new PositionalIndex();
  for (const [id, text] of docs) index.addDocument(id, text);
  return index;
}

test('phrase query matches brute-force enumeration', () => {
  const index = buildIndex();
  const phrases = [
    'quick brown fox',
    'fixed rate',
    'rate fixed',
    'fixed',
    '利率 固定 债券',
    'absent phrase',
    'the',
  ];
  for (const phrase of phrases) {
    assert.deepEqual(index.phrase(phrase), brutePhraseAll(DOCS, phrase), `phrase: ${phrase}`);
  }
});

test('near query matches enumerated windows for various k', () => {
  const index = buildIndex();
  const cases = [
    ['fixed coupon', 3],
    ['fixed coupon', 2],
    ['fixed payment', 6],
    ['fixed payment', 4],
    ['利率 付息', 3],
    ['利率 付息', 2],
    ['quick dog', 9],
    ['quick dog', 8],
    ['equity markets', 1],
  ];
  for (const [query, k] of cases) {
    assert.deepEqual(index.near(query, k), bruteNearAll(DOCS, query, k), `near: ${query} k=${k}`);
  }
});

test('removeDocument incrementally removes positions', () => {
  const index = buildIndex();
  assert.equal(index.removeDocument('n2'), true);
  const remaining = DOCS.filter(([id]) => id !== 'n2');
  assert.deepEqual(index.phrase('fixed rate'), brutePhraseAll(remaining, 'fixed rate'));
  assert.deepEqual(index.near('fixed coupon', 3), bruteNearAll(remaining, 'fixed coupon', 3));
  assert.equal(index.removeDocument('n2'), false);
  assert.equal(index.hasNode('n2'), false);
  assert.equal(index.hasNode('n1'), true);
});

test('serialize/deserialize preserves query results', () => {
  const index = buildIndex();
  const restored = PositionalIndex.deserialize(index.serialize());
  assert.deepEqual(restored.phrase('fixed rate'), index.phrase('fixed rate'));
  assert.deepEqual(restored.near('利率 付息', 3), index.near('利率 付息', 3));
});
