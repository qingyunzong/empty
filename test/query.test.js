import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tokenize, phraseHits, nearHits, compareIds } from '../src/query.js';

// Reference: enumerate ALL unordered windows [lo, hi] per document, keep those
// covering every distinct query term within the slop bound, take the minimal
// span per document, then order by (span asc, evidence id asc).
function referenceNear(documents, query, slop) {
  const terms = [...new Set(tokenize(query))];
  const maxSpan = terms.length - 1 + slop;
  const out = [];
  for (const doc of documents) {
    const tokens = tokenize(doc.text);
    let best = null;
    for (let lo = 0; lo < tokens.length; lo++) {
      for (let hi = lo; hi < tokens.length; hi++) {
        const span = hi - lo;
        if (span > maxSpan) break;
        if (best && span > best) break;
        const window = tokens.slice(lo, hi + 1);
        if (terms.every((t) => window.includes(t))) {
          best = span;
        }
      }
    }
    if (best !== null) out.push({ evidenceId: doc.id, distance: best });
  }
  out.sort((a, b) => a.distance - b.distance || compareIds(a.evidenceId, b.evidenceId));
  return out;
}

const docs = [
  { id: 'E1', revision: 1, text: 'the quick brown fox jumps over the lazy dog' },
  { id: 'E2', revision: 1, text: 'cardholder disputes the card network chargeback fee' },
  { id: 'E3', revision: 1, text: 'chargeback fee charged by the card network twice' },
  { id: 'E4', revision: 1, text: 'network card cardholder card network fee' },
  { id: 'E5', revision: 1, text: 'no relevant terms here at all' },
];

test('phrase query returns exact consecutive matches with positions', () => {
  const hits = phraseHits(docs, 'card network');
  assert.deepEqual(
    hits.map((h) => ({ id: h.evidenceId, positions: h.positions })),
    [
      { id: 'E2', positions: [3, 4] },
      { id: 'E3', positions: [5, 6] },
      { id: 'E4', positions: [3, 4] },
    ],
  );
});

test('phrase query finds repeated occurrences in one document', () => {
  const hits = phraseHits([{ id: 'X', revision: 1, text: 'a b a b a b' }], 'a b');
  assert.deepEqual(hits.map((h) => h.positions), [[0, 1], [2, 3], [4, 5]]);
});

test('phrase with no match returns empty', () => {
  assert.deepEqual(phraseHits(docs, 'lazy cardholder'), []);
});

test('slop=2 unordered near matches reference enumeration', () => {
  const got = nearHits(docs, 'card network fee', 2);
  const want = referenceNear(docs, 'card network fee', 2);
  assert.deepEqual(
    got.map((h) => ({ evidenceId: h.evidenceId, distance: h.distance })),
    want,
  );
  // sanity: E5 has no terms, E1 none either
  assert.ok(!got.some((h) => h.evidenceId === 'E5'));
  assert.ok(!got.some((h) => h.evidenceId === 'E1'));
});

test('near hits are ordered by distance asc then evidence id asc (deterministic ties)', () => {
  const tied = [
    { id: 'B', revision: 1, text: 'x alpha q beta y' },
    { id: 'A', revision: 1, text: 'z beta q alpha w' },
    { id: 'C', revision: 1, text: 'alpha q r s t beta' },
  ];
  const hits = nearHits(tied, 'alpha beta', 2);
  // A and B both have distance 2 -> id asc: A before B; C distance 5 excluded by slop
  assert.deepEqual(
    hits.map((h) => [h.evidenceId, h.distance]),
    [['A', 2], ['B', 2]],
  );
  // repeat to confirm determinism
  const again = nearHits(tied, 'alpha beta', 2);
  assert.deepEqual(again, hits);
});

test('near with slop=0 requires adjacent terms (any order)', () => {
  const d = [
    { id: 'P', revision: 1, text: 'beta alpha' },
    { id: 'Q', revision: 1, text: 'beta x alpha' },
  ];
  const hits = nearHits(d, 'alpha beta', 0);
  assert.deepEqual(hits.map((h) => h.evidenceId), ['P']);
});

// Seeded PRNG (mulberry32) for a reproducible randomized cross-check.
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

test('randomized: library near hits equal reference enumeration (slop=2)', () => {
  const rand = mulberry32(20261003);
  const vocab = ['alpha', 'beta', 'gamma', 'delta', 'epsilon', 'zeta'];
  for (let trial = 0; trial < 200; trial++) {
    const documents = [];
    const n = 1 + Math.floor(rand() * 6);
    for (let i = 0; i < n; i++) {
      const len = 1 + Math.floor(rand() * 15);
      const words = [];
      for (let j = 0; j < len; j++) words.push(vocab[Math.floor(rand() * vocab.length)]);
      documents.push({ id: `D${i}`, revision: 1, text: words.join(' ') });
    }
    const qLen = 2 + Math.floor(rand() * 2);
    const qTerms = [];
    while (qTerms.length < qLen) {
      const t = vocab[Math.floor(rand() * vocab.length)];
      if (!qTerms.includes(t)) qTerms.push(t);
    }
    const query = qTerms.join(' ');
    const got = nearHits(documents, query, 2).map((h) => ({
      evidenceId: h.evidenceId,
      distance: h.distance,
    }));
    const want = referenceNear(documents, query, 2);
    assert.deepEqual(got, want, `trial ${trial} query="${query}" docs=${JSON.stringify(documents)}`);
  }
});
