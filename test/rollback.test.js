import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/store.js';
import { makeRegistry, tmpdir, SAFE_MANIFEST } from './helpers.js';

function seededStore() {
  const store = new Store(tmpdir(), makeRegistry());
  store.commitSafeSet(SAFE_MANIFEST);
  store.set('temp', 40);
  store.lock('temp');
  store.issueCert('temp', 'CERT-1');
  return store;
}

test('rollback layers must run unlock -> params -> certs', () => {
  const store = seededStore();
  assert.throws(() => store.rollback('params-reverted'), (e) => e.code === 'ROLLBACK');
  assert.throws(() => store.rollback('certs-cleared'), (e) => e.code === 'ROLLBACK');

  store.rollback('unlocked');
  assert.deepEqual(store.state.locks, {});
  assert.throws(() => store.rollback('certs-cleared'), (e) => e.code === 'ROLLBACK');
  assert.throws(() => store.rollback('unlocked'), (e) => e.code === 'ROLLBACK');

  store.rollback('params-reverted');
  assert.equal(store.state.values.temp, SAFE_MANIFEST.values.temp);
  assert.throws(() => store.rollback('params-reverted'), (e) => e.code === 'ROLLBACK');

  store.rollback('certs-cleared');
  assert.deepEqual(store.state.certs, {});
  assert.equal(store.state.rollbackPhase, 'certs-cleared');
});

test('rollbackAll runs the full layered sequence', () => {
  const store = seededStore();
  store.rollbackAll();
  assert.deepEqual(store.state.locks, {});
  assert.equal(store.state.values.temp, SAFE_MANIFEST.values.temp);
  assert.deepEqual(store.state.certs, {});
});

test('rollback phase persists across recovery', () => {
  const dir = tmpdir();
  const registry = makeRegistry();
  const store = new Store(dir, registry);
  store.commitSafeSet(SAFE_MANIFEST);
  store.lock('temp');
  store.rollback('unlocked');
  const recovered = Store.load(dir, registry);
  assert.equal(recovered.state.rollbackPhase, 'unlocked');
  assert.throws(() => recovered.rollback('certs-cleared'), (e) => e.code === 'ROLLBACK');
});
