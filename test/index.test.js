import test from 'node:test';
import assert from 'node:assert/strict';
import { TradeStore } from '../src/store.js';
import { tmpdir } from './helpers.js';

function buildStore(dir, threshold = 0.2) {
  const store = TradeStore.open(dir, { compactionThreshold: threshold });
  store.addTrade({ id: 'T1', buyer: 'A', seller: 'B', amount: 10, desc: 'quick brown fox jumps' });
  store.addTrade({ id: 'T2', buyer: 'A', seller: 'B', amount: 10, desc: 'quick brown dog barks' });
  store.addTrade({ id: 'T3', buyer: 'B', seller: 'A', amount: 10, desc: 'the quick brown fox sleeps' });
  store.addTrade({ id: 'T4', buyer: 'B', seller: 'A', amount: 10, desc: 'quick fox brown' });
  store.save();
  return store;
}

test('phrase query only matches consecutive positions', () => {
  const store = buildStore(tmpdir());
  const cert = store.phraseQuery('quick brown fox');
  assert.deepStrictEqual(cert.hits.map((h) => h.id), ['T1', 'T3']);
  assert.deepStrictEqual(store.phraseQuery('quick fox').hits.map((h) => h.id), ['T4']);
  assert.ok(cert.segments.length > 0, 'certificate lists compressed segments');
  assert.ok(cert.segments.every((s) => s.id !== undefined && 'positions' in s));
  assert.match(cert.hash, /^[0-9a-f]{64}$/);
});

test('delete reduces phrase results; compaction + restart keeps results and hash', () => {
  const dir = tmpdir();
  const store = buildStore(dir);
  const before = store.phraseQuery('quick brown fox');
  assert.strictEqual(before.hits.length, 2);

  const del = store.deleteTrade('T3');
  assert.ok(del.tombstoned.positions > 0, 'tombstones written');
  store.save();
  const after = store.phraseQuery('quick brown fox');
  assert.deepStrictEqual(after.hits.map((h) => h.id), ['T1'], 'phrase results shrink after delete');

  const report = store.index.segmentReport();
  const seg = report.find((s) => s.id !== 'active');
  assert.ok(seg.dead > 0 && seg.tombstoned.includes('T3'), 'dead positions tracked');

  const compacted = store.compact();
  assert.ok(compacted.length > 0, 'compaction triggered over threshold');
  store.save();
  const afterCompact = store.phraseQuery('quick brown fox');
  assert.deepStrictEqual(afterCompact.hits, after.hits);
  assert.strictEqual(afterCompact.hash, after.hash);
  assert.strictEqual(store.index.segmentReport().find((s) => s.id !== 'active').dead, 0);

  const reopened = TradeStore.open(dir, { compactionThreshold: 0.2 });
  const afterRestart = reopened.phraseQuery('quick brown fox');
  assert.deepStrictEqual(afterRestart.hits, after.hits, 'same results after restart');
  assert.strictEqual(afterRestart.hash, after.hash, 'same hash after restart');
  assert.strictEqual(afterRestart.hash, afterCompact.hash);
});

test('revoked trades stay searchable, deleted trades do not', () => {
  const store = buildStore(tmpdir());
  store.revokeTrade('T1');
  assert.deepStrictEqual(store.phraseQuery('quick brown fox').hits.map((h) => h.id), ['T1', 'T3']);
  store.deleteTrade('T1');
  assert.deepStrictEqual(store.phraseQuery('quick brown fox').hits.map((h) => h.id), ['T3']);
});
