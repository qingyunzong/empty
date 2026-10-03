import test from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/store.js';
import { tokenize } from '../src/indexer.js';
import { tmpdir, mulberry32, brutePhrase, bruteNear, hashResults } from './helpers.js';

const VOCAB = ['alpha', 'beta', 'gamma', 'delta', 'epsilon', 'zeta',
  'eta', 'theta', 'iota', 'kappa', 'lambda', 'mu'];

function makeDocs(seed, count) {
  const rand = mulberry32(seed);
  const docs = [];
  for (let i = 0; i < count; i++) {
    const len = 5 + Math.floor(rand() * 8);
    const words = [];
    for (let j = 0; j < len; j++) words.push(VOCAB[Math.floor(rand() * VOCAB.length)]);
    docs.push({
      id: `doc-${String(i).padStart(3, '0')}`,
      tradeId: `trade-${i % 5}`,
      fee: 1 + Math.floor(rand() * 20),
      refundBudget: 500,
      text: words.join(' '),
      state: 'open',
    });
  }
  return docs;
}

function makeQueries(docs) {
  const phrases = [];
  for (const doc of docs.slice(0, 10)) {
    const tokens = tokenize(doc.text);
    phrases.push(tokens.slice(0, 2).join(' '));
    if (tokens.length >= 3) phrases.push(tokens.slice(1, 4).join(' '));
  }
  phrases.push('alpha beta', 'mu lambda theta', 'no-such-term alpha');
  const nears = [
    { terms: ['alpha', 'beta'], window: 3 },
    { terms: ['gamma', 'delta', 'epsilon'], window: 5 },
    { terms: ['zeta', 'mu'], window: 2 },
    { terms: ['theta', 'kappa', 'alpha'], window: 8 },
    { terms: ['alpha', 'alpha'], window: 4 },
  ];
  return { phrases, nears };
}

function runAllQueries(store, queries) {
  return {
    phrases: queries.phrases.map((p) => store.queryPhrase(p).slice().sort()),
    nears: queries.nears.map((q) => store.queryNear(q.terms, q.window).slice().sort()),
  };
}

function assertMatchesBruteForce(store, queries, liveDocs) {
  for (const phrase of queries.phrases) {
    assert.deepEqual(store.queryPhrase(phrase).slice().sort(),
      brutePhrase(liveDocs, phrase), `phrase: ${phrase}`);
  }
  for (const { terms, window } of queries.nears) {
    assert.deepEqual(store.queryNear(terms, window).slice().sort(),
      bruteNear(liveDocs, terms, window), `near: ${terms} w=${window}`);
  }
}

test('phrase and near match brute-force enumeration before and after deletes; merge keeps hash', () => {
  const dir = tmpdir();
  const store = Store.open(dir, { mergeThreshold: 0 });
  const docs = makeDocs(42, 40);
  for (const doc of docs) store.append(doc);
  const queries = makeQueries(docs);
  const liveDocs = new Map(docs.map((d) => [d.id, d.text]));

  assertMatchesBruteForce(store, queries, liveDocs);

  const deleted = docs.filter((_, i) => i % 3 === 0).map((d) => d.id);
  for (const id of deleted) {
    store.delete(id);
    liveDocs.delete(id);
  }
  assertMatchesBruteForce(store, queries, liveDocs);

  const hashBeforeMerge = hashResults(runAllQueries(store, queries));
  const result = store.merge();
  assert.equal(result.live, liveDocs.size);
  const hashAfterMerge = hashResults(runAllQueries(store, queries));
  assert.equal(hashAfterMerge, hashBeforeMerge);

  const reopened = Store.open(dir, { mergeThreshold: 0 });
  assert.equal(hashResults(runAllQueries(reopened, queries)), hashBeforeMerge);
  assertMatchesBruteForce(reopened, queries, liveDocs);
});

test('auto-merge triggers when segment liveness drops below threshold', () => {
  const dir = tmpdir();
  const store = Store.open(dir, { mergeThreshold: 0.5 });
  const docs = makeDocs(7, 10);
  for (const doc of docs) store.append(doc);
  assert.equal(store.stats().generation, 1);
  for (let i = 0; i < 6; i++) store.delete(docs[i].id);
  const stats = store.stats();
  assert.equal(stats.generation, 2);
  assert.equal(stats.live, 4);
  assert.equal(stats.segments.length, 1);
  assert.equal(stats.segments[0].liveness, 1);
});
