import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/store.js';
import { makeRegistry, tmpdir, SAFE_MANIFEST } from './helpers.js';

const CRASH = (e) => e.code === 'CRASH';

test('fault before-delta-append: nothing applied after recovery', () => {
  const dir = tmpdir();
  const registry = makeRegistry();
  const store = new Store(dir, registry, { faultAt: 'before-delta-append' });
  store.faultAt = null;
  store.set('temp', 10);
  store.faultAt = 'before-delta-append';
  assert.throws(() => store.set('temp', 42), CRASH);

  const recovered = Store.load(dir, registry);
  assert.equal(recovered.state.values.temp, 10);
});

test('fault after-delta-append: batch fully replayed after recovery', () => {
  const dir = tmpdir();
  const registry = makeRegistry();
  const store = new Store(dir, registry, { faultAt: 'after-delta-append' });
  assert.throws(
    () => store.applyEntries([
      { op: 'set', key: 'temp', value: 42 },
      { op: 'set', key: 'boost', value: true },
    ]),
    CRASH,
  );

  const recovered = Store.load(dir, registry);
  // no half-applied batch: both entries survive, not just the first
  assert.equal(recovered.state.values.temp, 42);
  assert.equal(recovered.state.values.boost, true);
});

test('fault before-active-rename: delta replay keeps state consistent', () => {
  const dir = tmpdir();
  const registry = makeRegistry();
  const store = new Store(dir, registry, { faultAt: 'before-active-rename' });
  assert.throws(() => store.set('temp', 77), CRASH);

  const recovered = Store.load(dir, registry);
  assert.equal(recovered.state.values.temp, 77);
  // active.json was rebuilt from the delta log and is loadable again
  const again = Store.load(dir, registry);
  assert.equal(again.state.values.temp, 77);
});

test('fault after-safe-commit: dangerous values overridden by safe set on recovery', () => {
  const dir = tmpdir();
  const registry = makeRegistry();
  const store = new Store(dir, registry, { faultAt: 'after-safe-commit' });
  store.faultAt = null;
  store.set('temp', 30);
  store.set('pressure', 5);
  // simulate a corrupted / forced controller write of a dangerous value
  store.forceSet('temp', 500);
  store.faultAt = 'after-safe-commit';
  assert.throws(() => store.commitSafeSet(SAFE_MANIFEST), CRASH);

  const recovered = Store.load(dir, registry);
  assert.equal(recovered.state.values.temp, SAFE_MANIFEST.values.temp);
  assert.equal(recovered.state.values.pressure, 5);
});

test('recovery without any fault replays cleanly', () => {
  const dir = tmpdir();
  const registry = makeRegistry();
  const store = new Store(dir, registry);
  store.set('temp', 33);
  store.lock('pressure');
  store.issueCert('temp', 'CERT-9');
  const recovered = Store.load(dir, registry);
  assert.equal(recovered.state.values.temp, 33);
  assert.equal(recovered.state.locks.pressure, true);
  assert.equal(recovered.state.certs.temp, 'CERT-9');
});
