import { test } from 'node:test';
import assert from 'node:assert/strict';
import { searchDocs, tokenize } from '../src/index.js';
import { mulberry32, refPhraseHits, refNearWindows } from '../testutil/reference.js';

test('phrase query finds consecutive term positions', () => {
  const docs = [
    { key: 'ev-1', revision: 1, text: 'the quick brown fox jumps' },
    { key: 'ev-2', revision: 1, text: 'quick brown quick brown' },
    { key: 'ev-3', revision: 1, text: 'quick red brown' },
  ];
  const hits = searchDocs(docs, { type: 'phrase', terms: ['quick', 'brown'] });
  assert.deepEqual(
    hits.map((h) => [h.evidenceId, h.start, h.end]),
    [['ev-1', 1, 2], ['ev-2', 0, 1], ['ev-2', 2, 3]],
  );
});

test('phrase query is case-insensitive and order-sensitive', () => {
  const docs = [{ key: 'a', revision: 1, text: 'Alpha BETA gamma beta alpha' }];
  assert.equal(searchDocs(docs, { type: 'phrase', terms: ['ALPHA', 'beta'] }).length, 1);
  assert.equal(searchDocs(docs, { type: 'phrase', terms: ['beta', 'alpha'] }).length, 1);
  assert.equal(searchDocs(docs, { type: 'phrase', terms: ['alpha', 'gamma'] }).length, 0);
});

test('unordered near with slop=2 matches either term order', () => {
  const docs = [
    { key: 'fwd', revision: 1, text: 'apple x x banana' },
    { key: 'bwd', revision: 1, text: 'banana x x apple' },
    { key: 'far', revision: 1, text: 'apple x x x banana' },
    { key: 'adj', revision: 1, text: 'apple banana' },
  ];
  const hits = searchDocs(docs, { type: 'near', terms: ['apple', 'banana'], slop: 2 });
  assert.deepEqual(
    hits.map((h) => [h.evidenceId, h.distance, h.start, h.end]),
    [['adj', 1, 0, 1], ['bwd', 3, 0, 3], ['fwd', 3, 0, 3]],
  );
});

test('near hits sort by distance asc then evidence id asc (deterministic ties)', () => {
  const docs = [
    { key: 'ev-9', revision: 1, text: 'pay now fraud later' },
    { key: 'ev-1', revision: 1, text: 'fraud pay' },
    { key: 'ev-5', revision: 1, text: 'pay fraud' },
    { key: 'ev-3', revision: 1, text: 'pay a b fraud' },
  ];
  const hits = searchDocs(docs, { type: 'near', terms: ['pay', 'fraud'], slop: 2 });
  assert.deepEqual(
    hits.map((h) => [h.evidenceId, h.distance]),
    [['ev-1', 1], ['ev-5', 1], ['ev-9', 2], ['ev-3', 3]],
  );
  const again = searchDocs([...docs].reverse(), { type: 'near', terms: ['pay', 'fraud'], slop: 2 });
  assert.deepEqual(again, hits);
});

test('three-term unordered near honours slop budget', () => {
  const docs = [{ key: 'd', revision: 1, text: 'c x b x a' }];
  // window 0..4, distance 4, n=3 -> extra 2 <= slop 2
  assert.equal(searchDocs(docs, { type: 'near', terms: ['a', 'b', 'c'], slop: 2 }).length, 1);
  assert.equal(searchDocs(docs, { type: 'near', terms: ['a', 'b', 'c'], slop: 1 }).length, 0);
});

test('library near results equal brute-force enumeration of all unordered windows', () => {
  const rng = mulberry32(20261003);
  const vocab = ['alpha', 'beta', 'gamma', 'delta', 'eps'];
  for (let iter = 0; iter < 300; iter++) {
    const len = 1 + Math.floor(rng() * 12);
    const text = Array.from({ length: len }, () => vocab[Math.floor(rng() * vocab.length)]).join(' ');
    const t1 = vocab[Math.floor(rng() * vocab.length)];
    const t2 = vocab[Math.floor(rng() * vocab.length)];
    const docs = [{ key: 'doc', revision: 1, text }];
    const got = searchDocs(docs, { type: 'near', terms: [t1, t2], slop: 2 });
    const want = refNearWindows(text, [t1, t2], 2)
      .sort((a, b) => a.distance - b.distance || a.start - b.start || a.end - b.end);
    assert.deepEqual(
      got.map((h) => [h.start, h.end, h.distance, h.positions]),
      want.map((h) => [h.start, h.end, h.distance, h.positions]),
      `mismatch for text=${JSON.stringify(text)} terms=[${t1},${t2}]`,
    );
  }
});

test('library phrase results equal naive reference scan', () => {
  const rng = mulberry32(7);
  const vocab = ['red', 'green', 'blue'];
  for (let iter = 0; iter < 300; iter++) {
    const len = 1 + Math.floor(rng() * 10);
    const text = Array.from({ length: len }, () => vocab[Math.floor(rng() * vocab.length)]).join(' ');
    const terms = [vocab[Math.floor(rng() * 3)], vocab[Math.floor(rng() * 3)]];
    const got = searchDocs([{ key: 'd', revision: 1, text }], { type: 'phrase', terms });
    const want = refPhraseHits(text, terms);
    assert.deepEqual(
      got.map((h) => [h.start, h.end]),
      want.map((h) => [h.start, h.end]),
      `mismatch for text=${JSON.stringify(text)} terms=${JSON.stringify(terms)}`,
    );
  }
});

test('tokenize splits on non-alphanumerics and lowercases', () => {
  assert.deepEqual(tokenize('  Visa-4,000.00; MASTERCARD '), ['visa', '4', '000', '00', 'mastercard']);
});
