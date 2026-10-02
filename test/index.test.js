import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { OrderStore } from '../src/store.js';
import { rng, sha256, brutePhrase, bruteNear } from '../testutil/helpers.js';

function tmpdir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'oes-index-'));
}

const VOCAB = ['alpha', 'beta', 'gamma', 'delta', 'order', 'trade', 'fee', 'refund', 'book'];

function makeTextEvents(seed, n) {
  const rand = rng(seed);
  const events = [];
  for (let i = 0; i < n; i++) {
    const len = 3 + Math.floor(rand() * 12);
    const words = [];
    for (let k = 0; k < len; k++) words.push(VOCAB[Math.floor(rand() * VOCAB.length)]);
    events.push({
      id: `d${String(i).padStart(3, '0')}`,
      tradeId: `T${i}`,
      fee: 1,
      refundBudget: 10,
      text: words.join(' '),
      state: 'open',
    });
  }
  return events;
}

const PHRASES = ['alpha beta', 'order trade fee', 'beta gamma delta', 'refund book'];
const NEAR_QUERIES = [
  { terms: ['alpha', 'beta'], window: 2 },
  { terms: ['order', 'fee', 'book'], window: 4 },
  { terms: ['gamma', 'delta'], window: 0 },
  { terms: ['trade', 'refund'], window: 6 },
];

function liveEvents(store) {
  return [...store.events.values()].filter((ev) => !store.deleted.has(ev.id));
}

function assertQueriesMatchBruteForce(store) {
  const live = liveEvents(store);
  for (const p of PHRASES) {
    assert.deepEqual(store.phraseQuery(p), brutePhrase(live, p), `phrase "${p}"`);
  }
  for (const { terms, window } of NEAR_QUERIES) {
    assert.deepEqual(store.nearQuery(terms, window), bruteNear(live, terms, window), `near ${terms}`);
  }
}

function querySnapshot(store) {
  return {
    phrase: PHRASES.map((p) => store.phraseQuery(p)),
    near: NEAR_QUERIES.map(({ terms, window }) => store.nearQuery(terms, window)),
  };
}

test('phrase and near results match brute-force enumeration before and after deletes', async () => {
  const dir = tmpdir();
  const store = await OrderStore.open(dir);
  const events = makeTextEvents(7, 120);
  for (const ev of events) store.addEvent(ev);

  assertQueriesMatchBruteForce(store);

  // Tombstone deletes: index must agree with enumeration over remaining texts.
  for (const ev of events.filter((_, i) => i % 3 === 0)) {
    await store.delete(ev.id);
  }
  assertQueriesMatchBruteForce(store);
  await store.close();
});

test('merge preserves query results (hash identical) and old/new segments agree', async () => {
  const dir = tmpdir();
  const store = await OrderStore.open(dir);
  const events = makeTextEvents(11, 150);
  for (const ev of events) store.addEvent(ev);
  for (const ev of events.filter((_, i) => i % 4 === 0)) {
    await store.delete(ev.id);
  }
  assert.ok(store.liveness() < 1, 'deletes should lower liveness');

  const beforeHash = sha256(querySnapshot(store));

  // Snapshot the pre-merge directory: queries on the old segments.
  const oldDir = tmpdir();
  fs.cpSync(dir, oldDir, { recursive: true });

  // Queries issued while the merge is in flight must see a consistent view.
  const mergePromise = store.merge();
  const duringHash = sha256(querySnapshot(store));
  await mergePromise;
  const afterHash = sha256(querySnapshot(store));

  assert.equal(duringHash, beforeHash, 'queries during merge must be consistent');
  assert.equal(afterHash, beforeHash, 'hash must be identical after merge');
  assert.equal(store.segments.length, 1, 'merge compacts to a single segment');

  // A store opened on the old segments answers identically to one on the new.
  const oldStore = await OrderStore.open(oldDir);
  const newStore = await OrderStore.open(dir);
  assert.equal(sha256(querySnapshot(oldStore)), sha256(querySnapshot(newStore)));
  assertQueriesMatchBruteForce(newStore);

  await oldStore.close();
  await newStore.close();
  await store.close();
});

test('autoMerge triggers when liveness drops below threshold', async () => {
  const dir = tmpdir();
  const store = await OrderStore.open(dir, { mergeThreshold: 0.6, autoMerge: true });
  const events = makeTextEvents(3, 10);
  for (const ev of events) store.addEvent(ev);
  for (const ev of events.slice(0, 7)) {
    await store.delete(ev.id);
  }
  assert.equal(store.segments.length, 1, 'auto merge should have compacted');
  const live = events.slice(7);
  const expected = {
    phrase: PHRASES.map((p) => brutePhrase(live, p)),
    near: NEAR_QUERIES.map(({ terms, window }) => bruteNear(live, terms, window)),
  };
  assert.equal(sha256(querySnapshot(store)), sha256(expected));
  await store.close();
});
