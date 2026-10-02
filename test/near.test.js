import test from 'node:test';
import assert from 'node:assert/strict';
import { TradeStore } from '../src/store.js';
import { tmpdir } from './helpers.js';

test('near query finds minimal window and breaks ties by smallest id', () => {
  const store = TradeStore.open(tmpdir());
  store.addTrade({ id: 'T1', buyer: 'A', seller: 'B', amount: 1, desc: 'alpha x x x beta' });
  store.addTrade({ id: 'T2', buyer: 'A', seller: 'B', amount: 1, desc: 'alpha x beta' });
  store.addTrade({ id: 'T3', buyer: 'A', seller: 'B', amount: 1, desc: 'beta y alpha' });
  const cert = store.nearQuery('alpha beta', 10);
  assert.strictEqual(cert.bestWindow, 3);
  assert.strictEqual(cert.best, 'T2', 'equal shortest windows: smallest id wins');
  assert.deepStrictEqual(
    cert.hits.map((h) => [h.id, h.window]),
    [['T2', 3], ['T3', 3], ['T1', 5]],
  );
});

test('near query respects k and reports segments in certificate', () => {
  const store = TradeStore.open(tmpdir());
  store.addTrade({ id: 'T1', buyer: 'A', seller: 'B', amount: 1, desc: 'alpha x x x beta' });
  store.addTrade({ id: 'T2', buyer: 'A', seller: 'B', amount: 1, desc: 'alpha x beta' });
  const wide = store.nearQuery('alpha beta', 5);
  assert.strictEqual(wide.hits.length, 2);
  const narrow = store.nearQuery('alpha beta', 2);
  assert.strictEqual(narrow.hits.length, 0);
  assert.strictEqual(narrow.best, null);
  assert.ok(wide.segments.length > 0);
  assert.throws(() => store.nearQuery('alpha beta', 1), /k must be/);
});
