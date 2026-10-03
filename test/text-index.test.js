import test from 'node:test';
import assert from 'node:assert/strict';
import { TextIndex, tokenize } from '../src/text-index.js';

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const VOCAB = ['alpha', 'beta', 'gamma', 'delta', 'epsilon'];

function makeDocs(seed, count) {
  const rnd = mulberry32(seed);
  const docs = new Map();
  for (let i = 0; i < count; i++) {
    const len = 4 + Math.floor(rnd() * 9);
    const tokens = Array.from({ length: len }, () => VOCAB[Math.floor(rnd() * VOCAB.length)]);
    docs.set(`doc${i}`, tokens);
  }
  return docs;
}

function brutePhrase(tokens, phraseTerms) {
  const hits = [];
  for (let i = 0; i + phraseTerms.length <= tokens.length; i++) {
    if (phraseTerms.every((t, j) => tokens[i + j] === t)) hits.push(i);
  }
  return hits;
}

function bruteNear(tokens, a, b, k) {
  const pairs = [];
  for (let i = 0; i < tokens.length; i++) {
    if (tokens[i] !== a) continue;
    for (let j = i + 1; j < tokens.length && j - i <= k; j++) {
      if (tokens[j] === b) pairs.push([i, j]);
    }
  }
  return pairs;
}

function* tuples(vocab, len, prefix = []) {
  if (len === 0) {
    yield prefix;
    return;
  }
  for (const word of vocab) yield* tuples(vocab, len - 1, [...prefix, word]);
}

test('phrase query matches brute-force window enumeration on small samples', () => {
  const docs = makeDocs(42, 25);
  const index = new TextIndex();
  for (const [id, tokens] of docs) index.add(id, tokens.join(' '));

  for (const len of [1, 2, 3]) {
    for (const phraseTerms of tuples(VOCAB, len)) {
      const expected = {};
      for (const [id, tokens] of docs) {
        const hits = brutePhrase(tokens, phraseTerms);
        if (hits.length > 0) expected[id] = hits;
      }
      const actual = Object.fromEntries(index.phrase(phraseTerms));
      assert.deepEqual(actual, expected, `phrase ${phraseTerms.join(' ')}`);
    }
  }
});

test('ordered near query matches brute-force window enumeration on small samples', () => {
  const docs = makeDocs(7, 25);
  const index = new TextIndex();
  for (const [id, tokens] of docs) index.add(id, tokens.join(' '));

  for (const a of VOCAB) {
    for (const b of VOCAB) {
      for (const k of [1, 2, 3, 4]) {
        const expected = {};
        for (const [id, tokens] of docs) {
          const pairs = bruteNear(tokens, a, b, k);
          if (pairs.length > 0) expected[id] = pairs;
        }
        const actual = Object.fromEntries(index.near(a, b, k));
        assert.deepEqual(actual, expected, `near ${a} ${b} k=${k}`);
      }
    }
  }
});

test('removal compacts postings incrementally', () => {
  const index = new TextIndex();
  index.add('a', 'red blue red');
  index.add('b', 'blue green');
  assert.equal(index.termCount, 3);
  assert.equal(index.docCount, 2);

  index.remove('a');
  assert.deepEqual(index.postings('red'), {});
  assert.equal(index.termCount, 2);
  assert.deepEqual(index.postings('blue'), { b: [0] });
  assert.deepEqual(index.postings('green'), { b: [1] });

  index.remove('b');
  assert.equal(index.termCount, 0);
  assert.equal(index.docCount, 0);
});

test('tokenize is case-insensitive and unicode-aware', () => {
  assert.deepEqual(tokenize('Hello, WORLD! 保函 v2'), ['hello', 'world', '保函', 'v2']);
});
