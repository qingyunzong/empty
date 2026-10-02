import test from 'node:test';
import assert from 'node:assert/strict';
import { TradeStore } from '../src/store.js';
import { tmpdir } from './helpers.js';

function seeded() {
  const store = TradeStore.open(tmpdir(), { marginRate: 0.1 });
  store.addTrade({ id: 'T1', buyer: 'A', seller: 'B', amount: 100, desc: 'hello world' });
  return store;
}

test('negative and non-positive amounts are rejected without state change', () => {
  const store = seeded();
  for (const amount of [-5, 0, NaN, Infinity, '100']) {
    const before = store.snapshot();
    assert.throws(
      () => store.addTrade({ id: 'T9', buyer: 'A', seller: 'B', amount, desc: 'x' }),
      (err) => err.code === 'NEGATIVE_AMOUNT',
    );
    assert.strictEqual(store.snapshot(), before, `state unchanged for amount=${amount}`);
  }
});

test('unknown trade revoke/delete are rejected without state change', () => {
  const store = seeded();
  const before = store.snapshot();
  assert.throws(() => store.revokeTrade('NOPE'), (err) => err.code === 'UNKNOWN_TRADE');
  assert.throws(() => store.deleteTrade('NOPE'), (err) => err.code === 'UNKNOWN_TRADE');
  assert.strictEqual(store.snapshot(), before);
});

test('duplicate delete is rejected without state change', () => {
  const store = seeded();
  store.deleteTrade('T1');
  const before = store.snapshot();
  assert.throws(() => store.deleteTrade('T1'), (err) => err.code === 'DUPLICATE_DELETE');
  assert.strictEqual(store.snapshot(), before);
});

test('duplicate id and invalid trades are rejected without state change', () => {
  const store = seeded();
  const before = store.snapshot();
  assert.throws(
    () => store.addTrade({ id: 'T1', buyer: 'A', seller: 'B', amount: 1, desc: '' }),
    (err) => err.code === 'DUPLICATE_ID',
  );
  assert.throws(
    () => store.addTrade({ id: 'T2', buyer: 'A', seller: 'A', amount: 1, desc: '' }),
    (err) => err.code === 'INVALID_TRADE',
  );
  assert.throws(
    () => store.addTrade({ id: 'T2', buyer: '', seller: 'B', amount: 1, desc: '' }),
    (err) => err.code === 'INVALID_TRADE',
  );
  assert.strictEqual(store.snapshot(), before);
});

test('revoking a non-active trade is rejected without state change', () => {
  const store = seeded();
  store.revokeTrade('T1');
  const before = store.snapshot();
  assert.throws(() => store.revokeTrade('T1'), (err) => err.code === 'INVALID_STATE');
  assert.strictEqual(store.snapshot(), before);
});
