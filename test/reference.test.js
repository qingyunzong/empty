import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Engine } from '../src/engine.js';
import { referenceQuery, makeCorpus } from '../test-helpers/helpers.js';

// Acceptance 2: index query results must equal naive per-word enumeration
// for every query in the matrix, over a generated corpus.
const QUERIES = [
  { phrase: '泵 气蚀' },
  { phrase: '泵' },
  { phrase: '泵 气蚀 原因码' },
  { phrase: '处理码 a07' },
  { phrase: '不存在 词项' },
  { near: ['c01', 'a07'], k: 0 },
  { near: ['c01', 'a07'], k: 4 },
  { near: ['c01', 'a07'], k: 5 },
  { near: ['原因码', '处理码'], k: 2 },
  { near: ['泵', '气蚀'], k: 3 },
  { phrase: '泵 气蚀', near: ['原因码', '处理码'], k: 4 },
  { phrase: '泵 气蚀', near: ['c01', 'a07'], k: 0 },
  { phrase: '泵 气蚀', near: ['c01', 'a07'], k: 6 },
  { phrase: '泵', near: ['c02', 'a09'], k: 4 },
];

for (const seed of [1, 7, 42]) {
  test(`index matches reference for all queries (seed=${seed})`, () => {
    const docs = makeCorpus(seed, 40);
    const e = new Engine();
    for (const d of docs) e.addDocument(d.text, d.ext);
    for (const q of QUERIES) {
      const got = e.query(q).map((r) => ({
        docID: r.docID, phraseHits: r.phraseHits, nearHits: r.nearHits, minSpan: r.minSpan,
      }));
      const want = referenceQuery(docs, q);
      assert.deepEqual(got, want, `query mismatch: ${JSON.stringify(q)}`);
    }
  });
}

test('index matches reference after incremental adds and deletes', () => {
  const docs = makeCorpus(99, 30);
  const e = new Engine();
  for (const d of docs.slice(0, 15)) e.addDocument(d.text, d.ext);
  for (const d of docs.slice(15)) e.addDocument(d.text, d.ext); // second batch
  e.deleteDocument(3);
  e.deleteDocument(11);
  const live = docs.filter((d) => d.docID !== 3 && d.docID !== 11);
  for (const q of QUERIES) {
    const got = e.query(q).map((r) => ({
      docID: r.docID, phraseHits: r.phraseHits, nearHits: r.nearHits, minSpan: r.minSpan,
    }));
    assert.deepEqual(got, referenceQuery(live, q), `query mismatch: ${JSON.stringify(q)}`);
  }
});
