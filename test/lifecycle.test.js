'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { Store } = require('../src/store');
const { tmpdir, tokenizeIndependent } = require('../testkit/helpers');

const DOCS = [
  { id: 'a', merchant: 'm1', amount: 10, tags: ['x'], status: 'settled', text: 'alpha beta gamma delta' },
  { id: 'b', merchant: 'm2', amount: 20, tags: ['y'], status: 'settled', text: 'beta gamma alpha beta gamma' },
  { id: 'c', merchant: 'm3', amount: 30, tags: ['z'], status: 'settled', text: 'gamma delta epsilon' },
];

function positionsFromText(text) {
  const map = {};
  tokenizeIndependent(text).forEach((t, i) => {
    (map[t] = map[t] || []).push(i);
  });
  return map;
}

test('revoke hides phrase, restore brings it back, restart keeps tombstone', () => {
  const dir = tmpdir();
  let store = Store.open(dir);
  store.addRecords(DOCS);
  assert.equal(store.query('beta gamma').hits.length, 2);

  store.delete('b');
  assert.deepEqual(store.query('beta gamma').hits.map((h) => h.id), ['a']);

  // restart: tombstone persists
  store = Store.open(dir);
  assert.deepEqual(store.query('beta gamma').hits.map((h) => h.id), ['a']);
  assert.equal(store.isLive('b'), false);

  store.restore('b');
  assert.deepEqual(store.query('beta gamma').hits.map((h) => h.id), ['a', 'b']);

  // restart: restore persists
  store = Store.open(dir);
  assert.deepEqual(store.query('beta gamma').hits.map((h) => h.id), ['a', 'b']);
});

test('compressed segment decodes to identical positions', () => {
  const dir = tmpdir();
  let store = Store.open(dir);
  store.addRecords(DOCS);
  store.delete('c'); // tombstone lives inside the segment too
  store = Store.open(dir);

  const decoded = store.decodeCurrentSegment();
  assert.equal(decoded.indexVersion, store.indexVersion);
  for (const doc of DOCS) {
    const expected = positionsFromText(doc.text);
    for (const [term, positions] of Object.entries(expected)) {
      assert.deepEqual(decoded.terms[term][doc.id], positions, `${doc.id}:${term}`);
    }
  }
});

test('certificate liveSha256 changes with tombstone and returns on restore', () => {
  const dir = tmpdir();
  const store = Store.open(dir);
  store.addRecords(DOCS);
  const before = store.query('beta').certificate;
  store.delete('a');
  const revoked = store.query('beta').certificate;
  assert.notEqual(revoked.liveSha256, before.liveSha256);
  assert.equal(revoked.liveCount, 2);
  assert.ok(revoked.indexVersion > before.indexVersion);
  store.restore('a');
  const restored = store.query('beta').certificate;
  assert.equal(restored.liveSha256, before.liveSha256);
});
