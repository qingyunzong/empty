import test from 'node:test';
import assert from 'node:assert/strict';
import { AlarmIndex } from '../src/index.js';
import { parseQuery } from '../src/query.js';
import { referenceQuery, CORPUS } from './helpers.js';

const QUERIES = [
  '"泵 气蚀"',
  '泵 气蚀', // bare multi-term input is a phrase too
  '泵',
  '气蚀',
  '处理码T204',
  '不存在的词',
  '原因码C102 NEAR/0 处理码T202',
  '原因码C102 NEAR/2 处理码T202',
  '原因码C103 NEAR/4 处理码T203',
  '原因码C103 NEAR/5 处理码T203',
  '处理码T204 NEAR/0 原因码C104', // reverse order pair
  '泵 NEAR/1 气蚀',
  'pump NEAR/2 normal',
];

function buildIndex() {
  const idx = new AlarmIndex();
  for (const doc of CORPUS) idx.addDocument(doc.id, doc.text);
  return idx;
}

test('index matches brute-force reference for all queries (no deletions)', () => {
  const idx = buildIndex();
  for (const q of QUERIES) {
    const expected = referenceQuery(CORPUS, new Set(), parseQuery(q));
    assert.deepEqual(idx.query(q), expected, `query: ${q}`);
  }
});

test('index matches reference with tombstoned documents', () => {
  const idx = buildIndex();
  idx.deleteDocument('m2');
  idx.deleteDocument('m6');
  const deleted = new Set(['m2', 'm6']);
  for (const q of QUERIES) {
    const expected = referenceQuery(CORPUS, deleted, parseQuery(q));
    assert.deepEqual(idx.query(q), expected, `query: ${q}`);
  }
});

test('index matches reference after compact', () => {
  const idx = buildIndex();
  idx.deleteDocument('m2');
  idx.deleteDocument('m6');
  idx.compact();
  const deleted = new Set(['m2', 'm6']);
  for (const q of QUERIES) {
    const expected = referenceQuery(CORPUS, deleted, parseQuery(q));
    assert.deepEqual(idx.query(q), expected, `query: ${q}`);
  }
});
