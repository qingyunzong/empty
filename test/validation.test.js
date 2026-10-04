import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/store.js';
import { makeRegistry, tmpdir } from './helpers.js';

test('out-of-range value rejected with VALIDATION', () => {
  const store = new Store(tmpdir(), makeRegistry());
  assert.throws(() => store.set('temp', 120), /VALIDATION|out of range/);
  assert.throws(() => store.set('temp', 120), (e) => e.code === 'VALIDATION');
  assert.throws(() => store.set('temp', -1), (e) => e.code === 'VALIDATION');
});

test('type mismatch rejected with VALIDATION', () => {
  const store = new Store(tmpdir(), makeRegistry());
  assert.throws(() => store.set('temp', 'hot'), (e) => e.code === 'VALIDATION');
  assert.throws(() => store.set('boost', 1), (e) => e.code === 'VALIDATION');
  assert.throws(() => store.set('nope', 1), (e) => e.code === 'VALIDATION');
});

test('interlock violation rejected with VALIDATION', () => {
  const store = new Store(tmpdir(), makeRegistry());
  store.set('pressure', 1);
  // temp >= 50 requires pressure > 2
  assert.throws(() => store.set('temp', 80), (e) => e.code === 'VALIDATION' && /interlock/.test(e.message));
  store.set('pressure', 5);
  store.set('temp', 80); // now legal
  assert.equal(store.state.values.temp, 80);
  // and lowering pressure below the interlock threshold is rejected too
  assert.throws(() => store.set('pressure', 1), (e) => e.code === 'VALIDATION');
});

test('locked param cannot be set, unlock restores', () => {
  const store = new Store(tmpdir(), makeRegistry());
  store.lock('temp');
  assert.throws(() => store.set('temp', 40), (e) => e.code === 'VALIDATION' && /locked/.test(e.message));
  store.unlock('temp');
  store.set('temp', 40);
  assert.equal(store.state.values.temp, 40);
});

test('batch apply is atomic: one bad entry rejects the whole batch', () => {
  const store = new Store(tmpdir(), makeRegistry());
  store.set('temp', 10);
  assert.throws(
    () => store.applyEntries([{ op: 'set', key: 'boost', value: true }, { op: 'set', key: 'temp', value: 999 }]),
    (e) => e.code === 'VALIDATION',
  );
  assert.equal(store.state.values.temp, 10);
  assert.equal(store.state.values.boost, undefined);
});
