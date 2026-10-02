'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { Store } = require('../src/store');
const { tmpdir, bruteForceWindows, normWindows } = require('../testkit/helpers');

const DOCS = [
  { id: 'v1', merchant: 'm1', amount: 100.5, tags: ['a'], status: 'settled',
    text: 'quick brown fox jumps over the lazy dog quick fox' },
  { id: 'v2', merchant: 'm1', amount: 20, tags: ['b'], status: 'settled',
    text: 'quick quick brown brown fox fox jumps jumps' },
  { id: 'v3', merchant: 'm2', amount: 7.25, tags: ['a', 'c'], status: 'settled',
    text: 'the quick blue hare and the brown quick fox of the woods' },
  { id: 'v4', merchant: 'm3', amount: 0, tags: [], status: 'pending',
    text: 'nothing relevant here at all' },
];

function makeStore() {
  const dir = tmpdir();
  const store = Store.open(dir);
  store.addRecords(DOCS);
  return store;
}

test('exact phrase and slop=1/2 match independent window enumeration', () => {
  const store = makeStore();
  const phrases = ['quick brown fox', 'quick fox', 'brown fox jumps', 'fox quick', 'the quick'];
  for (const phrase of phrases) {
    for (const slop of [0, 1, 2]) {
      const { hits, certificate } = store.query(phrase, { slop });
      const got = {};
      for (const h of hits) got[h.id] = normWindows(h.positions);
      const expected = {};
      for (const d of DOCS) {
        const w = normWindows(bruteForceWindows(d.text, phrase, slop));
        if (w.length > 0) expected[d.id] = w;
      }
      assert.deepEqual(got, expected, `phrase=${phrase} slop=${slop}`);
      assert.equal(certificate.query.slop, slop);
      assert.equal(certificate.indexVersion, 1);
      assert.match(certificate.liveSha256, /^[0-9a-f]{64}$/);
    }
  }
});

test('hits carry doc fields, matched positions, amount and certificate', () => {
  const store = makeStore();
  const { hits, certificate } = store.query('quick brown fox');
  const v1 = hits.find((h) => h.id === 'v1');
  assert.deepEqual(v1.positions, [[0, 1, 2]]);
  assert.equal(v1.amount, 100.5);
  assert.equal(v1.merchant, 'm1');
  assert.equal(certificate.liveCount, 4);
});
