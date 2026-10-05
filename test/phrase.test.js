import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { VoucherStore } from '../src/index.js';

const DOCS = [
  { id: 'd1', merchant: 'Acme', amount: 10, tags: ['a'], text: 'apple banana cherry apple banana', status: 'settled' },
  { id: 'd2', merchant: 'Beta', amount: 20, tags: ['b'], text: 'banana apple cherry', status: 'settled' },
  { id: 'd3', merchant: 'Acme', amount: 30, tags: ['a'], text: 'apple cherry banana', status: 'pending' },
  { id: 'd4', merchant: 'Gamma', amount: 40, tags: [], text: 'the quick brown fox jumps over the lazy dog', status: 'settled' },
  { id: 'd5', merchant: 'Delta', amount: 50, tags: ['x'], text: 'apple x y banana apple z banana', status: 'settled' },
  { id: 'd6', merchant: 'Echo', amount: 60, tags: [], text: 'foo foo bar foo', status: 'settled' },
];

// Independent reference: tokenize raw text and enumerate every ordered
// position tuple (cartesian product), keeping those within the slop budget.
function referenceTokens(text) {
  return text.toLowerCase().match(/[a-z0-9]+/g) ?? [];
}

function* cartesian(lists, i = 0, prefix = []) {
  if (i === lists.length) {
    yield prefix;
    return;
  }
  for (const v of lists[i]) yield* cartesian(lists, i + 1, [...prefix, v]);
}

function bruteForceHits(tokens, terms, slop) {
  const lists = terms.map((t) => tokens.flatMap((tok, i) => (tok === t ? [i] : [])));
  if (lists.some((l) => l.length === 0)) return [];
  const out = [];
  for (const combo of cartesian(lists)) {
    let slack = 0;
    let ok = true;
    for (let i = 1; i < combo.length; i++) {
      if (combo[i] <= combo[i - 1]) { ok = false; break; }
      slack += combo[i] - combo[i - 1] - 1;
    }
    if (ok && slack <= slop) out.push(combo);
  }
  return out;
}

function norm(hits) {
  return hits.map((h) => h.join(',')).sort();
}

const QUERIES = [
  'apple banana',
  'apple cherry banana',
  'quick brown fox',
  'banana apple',
  'foo bar',
  'foo foo',
  'lazy dog',
  'apple banana cherry',
];

test('phrase and slop=1/2 results match independent window enumeration', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'voucher-phrase-'));
  const store = VoucherStore.build(dir, DOCS);
  for (const phrase of QUERIES) {
    const terms = referenceTokens(phrase);
    for (const slop of [0, 1, 2]) {
      const { matches } = store.phraseQuery(phrase, { slop });
      const actual = {};
      for (const m of matches) actual[m.id] = norm(m.hits);
      const expected = {};
      for (const doc of DOCS) {
        const hits = bruteForceHits(referenceTokens(doc.text), terms, slop);
        if (hits.length > 0) expected[doc.id] = norm(hits);
      }
      assert.deepEqual(actual, expected, `phrase="${phrase}" slop=${slop}`);
    }
  }
});

test('query is ordered: reversed phrase does not match forward text', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'voucher-order-'));
  const store = VoucherStore.build(dir, DOCS);
  // "apple cherry" hits d2 (apple@1, cherry@2) and d3 (apple@0, cherry@1)
  assert.deepEqual(
    store.phraseQuery('apple cherry', { slop: 0 }).matches.map((m) => m.id).sort(),
    ['d2', 'd3'],
  );
  // "cherry apple" only hits d1 (cherry@2, apple@3); d2/d3 have the reversed order
  const reversed = store.phraseQuery('cherry apple', { slop: 2 });
  assert.deepEqual(reversed.matches.map((m) => m.id), ['d1']);
  assert.deepEqual(reversed.matches[0].hits, [[2, 3]]);
});

test('certificate carries index version, query and live-records sha256', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'voucher-cert-'));
  const store = VoucherStore.build(dir, DOCS);
  const { certificate, matches } = store.phraseQuery('apple banana', { slop: 1 });
  assert.equal(certificate.indexVersion, 1);
  assert.deepEqual(certificate.query, { phrase: 'apple banana', slop: 1 });
  assert.match(certificate.liveRecordsSha256, /^[0-9a-f]{64}$/);
  assert.ok(matches.every((m) => typeof m.amount === 'number' && Array.isArray(m.hits)));
  // revoking a live record changes the live-set hash
  store.revoke('d1');
  const after = store.phraseQuery('apple banana', { slop: 1 }).certificate;
  assert.notEqual(after.liveRecordsSha256, certificate.liveRecordsSha256);
});
