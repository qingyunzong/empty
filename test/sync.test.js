import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/store.js';
import { makeLibrary, mergeLibraries } from '../src/sync.js';
import { makeRegistry, tmpdir } from './helpers.js';

function libWith(node, key, value, clock) {
  return makeLibrary(node, [{ op: 'set', key, value, node, vector: { [node]: clock } }]);
}

test('causally ordered changes: newer vector wins', () => {
  const registry = makeRegistry();
  const a = libWith('eng', 'boost', true, 1);
  const b = makeLibrary('eng', [
    { op: 'set', key: 'boost', value: true, node: 'eng', vector: { eng: 1 } },
    { op: 'set', key: 'boost', value: false, node: 'eng', vector: { eng: 2 } },
  ]);
  const merged = mergeLibraries(a, b, registry);
  assert.equal(merged.pending.length, 0);
  assert.equal(merged.entries.find((e) => e.key === 'boost').value, false);
});

test('concurrent non-critical conflict resolves deterministically', () => {
  const registry = makeRegistry();
  const a = libWith('eng', 'label', 'alpha', 1);
  const b = libWith('ctl', 'label', 'beta', 1);
  const m1 = mergeLibraries(a, b, registry);
  const m2 = mergeLibraries(b, a, registry);
  assert.equal(m1.pending.length, 0);
  // same winner regardless of merge argument order
  assert.deepEqual(m1.entries, m2.entries);
});

test('concurrent safety-critical conflict goes pending, never auto-resolved', () => {
  const registry = makeRegistry();
  const a = libWith('eng', 'temp', 60, 1);
  const b = libWith('ctl', 'temp', 30, 1);
  const merged = mergeLibraries(a, b, registry);
  assert.equal(merged.pending.length, 1);
  assert.equal(merged.pending[0].key, 'temp');
});

test('version vectors merge as element-wise max', () => {
  const registry = makeRegistry();
  const a = libWith('eng', 'boost', true, 3);
  const b = libWith('ctl', 'boost', false, 2);
  const merged = mergeLibraries(a, b, registry);
  assert.deepEqual(merged.vector, { eng: 3, ctl: 2 });
});

test('end-to-end: pack down, feedback up, sync merges both', () => {
  const registry = makeRegistry();
  const engDir = tmpdir();
  const ctlDir = tmpdir();
  const eng = new Store(engDir, registry, { node: 'eng' });
  eng.set('boost', true);
  eng.set('label', 'fw-1.2');
  const pack = makeLibrary('eng', eng.exportEntries());

  const ctl = new Store(ctlDir, registry, { node: 'ctl' });
  ctl.applyEntries(pack.entries);
  ctl.set('label', 'fw-1.2-run'); // controller-side actual value
  const feedback = makeLibrary('ctl', ctl.exportEntries());

  const merged = mergeLibraries(pack, feedback, registry);
  assert.equal(merged.pending.length, 0);
  assert.equal(merged.entries.find((e) => e.key === 'label').value, 'fw-1.2-run');
  assert.deepEqual(merged.vector, { eng: 2, ctl: 1 });
});
