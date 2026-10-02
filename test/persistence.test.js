import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { compileSchema, PersistentStore, FaultInjected } from '../src/index.js';

const defs = [
  { key: 'temp', type: 'number', min: 0, max: 100, safety: true },
  { key: 'mode', type: 'string' },
];
const schema = compileSchema(defs);

function tmpdir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'param-sync-persist-'));
}

function applyWithFault(dir, fault) {
  const ps = new PersistentStore(dir, schema, 'eng', { fault });
  ps.commitSafeSet({ temp: 0 });
  ps.set('temp', 95); // dangerous
  ps.set('mode', 'boost');
  ps.commitSnapshot();
  return ps;
}

test('fault before-delta-append: no partial delta, recovery keeps safe values', () => {
  const dir = tmpdir();
  assert.throws(() => applyWithFault(dir, 'before-delta-append'), (e) => e instanceof FaultInjected && e.point === 'before-delta-append');
  const { store, report } = PersistentStore.recover(dir, schema, 'eng');
  assert.equal(store.store.get('temp'), 0);
  assert.equal(report.dirty, false);
});

test('fault after-delta-append: uncommitted delta is overridden by safe set', () => {
  const dir = tmpdir();
  assert.throws(() => applyWithFault(dir, 'after-delta-append'), FaultInjected);
  const { store, report } = PersistentStore.recover(dir, schema, 'eng');
  assert.equal(report.dirty, true);
  assert.deepEqual(report.overridden, ['temp']);
  assert.equal(store.store.get('temp'), 0, 'dangerous value must be covered by safe set');
  // recovery finalized: a second load is clean
  const again = PersistentStore.recover(dir, schema, 'eng');
  assert.equal(again.report.dirty, false);
  assert.equal(again.store.store.get('temp'), 0);
});

test('fault before-active-rename: old snapshot intact, dangerous delta covered', () => {
  const dir = tmpdir();
  assert.throws(() => applyWithFault(dir, 'before-active-rename'), FaultInjected);
  // tmp snapshot must not have been renamed into place
  assert.equal(fs.existsSync(path.join(dir, 'active.json')), false);
  const { store, report } = PersistentStore.recover(dir, schema, 'eng');
  assert.equal(report.dirty, true);
  assert.equal(store.store.get('temp'), 0);
  assert.equal(fs.existsSync(path.join(dir, 'active.json.tmp')), false, 'stale tmp cleaned');
});

test('fault after-manifest-commit: manifest committed, recovery consistent', () => {
  const dir = tmpdir();
  const ps = new PersistentStore(dir, schema, 'eng', { fault: 'after-manifest-commit' });
  assert.throws(() => ps.commitSafeSet({ temp: 0 }), (e) => e.point === 'after-manifest-commit');
  const { store, report } = PersistentStore.recover(dir, schema, 'eng');
  assert.equal(report.dirty, false);
  assert.equal(store.store.get('temp'), 0);
  assert.ok(store.readSafeSet(), 'committed manifest survives');
});

test('partial delta tail is discarded, never half-applied', () => {
  const dir = tmpdir();
  const ps = new PersistentStore(dir, schema, 'eng');
  ps.commitSafeSet({ temp: 0 });
  ps.set('mode', 'run');
  // simulate torn write: append half a line
  fs.appendFileSync(path.join(dir, 'delta.log'), '{"seq":2,"node":"eng","op":"set","key":"tem');
  const { report } = PersistentStore.recover(dir, schema, 'eng');
  assert.equal(report.replayed, 1);
  assert.equal(report.discarded, 1);
});

test('clean commit round-trips full state', () => {
  const dir = tmpdir();
  const ps = new PersistentStore(dir, schema, 'eng');
  ps.set('temp', 33);
  ps.set('mode', 'auto');
  ps.commitSnapshot();
  const { store, report } = PersistentStore.recover(dir, schema, 'eng');
  assert.equal(report.dirty, false);
  assert.equal(store.store.get('temp'), 33);
  assert.equal(store.store.get('mode'), 'auto');
});
