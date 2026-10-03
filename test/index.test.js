import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { GuaranteeStore, tokenize } from '../src/store.js';

const NOW = 1_000_000;
const FAR = NOW + 10_000_000;

function tmpdir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'cg-idx-'));
}

const DOCS = {
  d1: 'the quick brown fox jumps over the lazy dog',
  d2: 'quick brown fox quick fox',
  d3: 'the lazy dog sleeps the night',
  d4: 'performance bond payable on first written demand',
};

function build() {
  const store = new GuaranteeStore(tmpdir());
  for (const [id, terms] of Object.entries(DOCS)) {
    store.issue({ id, exposure: 1, cap: 10, terms, expiresAt: FAR, now: NOW });
  }
  return store;
}

// brute-force phrase positions over raw token arrays
function brutePhrase(termsText, phrase) {
  const doc = tokenize(termsText);
  const q = tokenize(phrase);
  const out = [];
  for (let i = 0; i + q.length <= doc.length; i++) {
    if (q.every((t, j) => doc[i + j] === t)) out.push(i);
  }
  return out;
}

// brute-force ordered-near windows: all p1<...<pm with pm-p1<=k
function bruteNear(termsText, terms, k) {
  const doc = tokenize(termsText);
  const lists = terms.map((t) => doc.flatMap((x, i) => (x === t ? [i] : [])));
  if (lists.some((l) => l.length === 0)) return [];
  const out = new Set();
  const walk = (level, min, acc) => {
    if (level === lists.length) {
      out.add(`${acc[0]}-${acc.at(-1)}`);
      return;
    }
    for (const p of lists[level]) {
      if (p > min && p - acc[0] <= k) walk(level + 1, p, [...acc, p]);
    }
  };
  for (const p1 of lists[0]) walk(1, p1, [p1]);
  return [...out].map((w) => w.split('-').map(Number)).sort((a, b) => a[0] - b[0] || a[1] - b[1]);
}

test('phrase query matches brute-force enumeration on every doc', () => {
  const store = build();
  const phrases = [
    'quick brown fox',
    'quick fox',
    'the lazy dog',
    'lazy dog sleeps',
    'fox jumps over',
    'on first written demand',
    'brown dog', // no hit anywhere
    'dog',
  ];
  for (const phrase of phrases) {
    const got = new Map(store.phraseQuery(phrase).map((r) => [r.id, r.positions]));
    const expected = new Map();
    for (const [id, text] of Object.entries(DOCS)) {
      const pos = brutePhrase(text, phrase);
      if (pos.length) expected.set(id, pos);
    }
    assert.deepEqual(got, expected, `phrase "${phrase}"`);
  }
});

test('ordered near query matches brute-force window enumeration', () => {
  const store = build();
  const cases = [
    [['fox', 'dog'], 5],
    [['fox', 'dog'], 3],
    [['jumps', 'dog'], 4],
    [['quick', 'fox'], 1],
    [['quick', 'fox'], 2],
    [['the', 'dog', 'sleeps'], 4],
    [['bond', 'demand'], 6],
    [['bond', 'demand'], 4],
  ];
  for (const [terms, k] of cases) {
    const got = new Map(store.nearQuery(terms, k).map((r) => [r.id, r.windows]));
    const expected = new Map();
    for (const [id, text] of Object.entries(DOCS)) {
      const w = bruteNear(text, terms, k);
      if (w.length) expected.set(id, w);
    }
    assert.deepEqual(got, expected, `near ${terms.join(',')} k=${k}`);
  }
});

test('logically deleted docs stay out of results; purge compacts the index', () => {
  const store = build();
  store.revoke('d2', NOW + 1);
  assert.deepEqual(store.phraseQuery('quick brown fox').map((r) => r.id), ['d1']);
  // postings of d2 still physically present (logical delete only)
  assert.ok(store.index.get('quick').has('d2'));
  const before = store.postingCount();
  const d2Postings = [...store.index.values()].filter((p) => p.has('d2')).length;
  store.purge('d2');
  assert.equal(store.postingCount(), before - d2Postings, 'postings incrementally removed');
  assert.ok(!store.index.get('quick')?.has('d2'));
  // remaining docs fully intact and verifiable
  assert.deepEqual(store.phraseQuery('quick brown fox').map((r) => r.id), ['d1']);
  assert.ok(store.verify().ok);
});
