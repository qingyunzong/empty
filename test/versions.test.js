import test from 'node:test';
import assert from 'node:assert/strict';
import { VersionStore, normalizedHash } from '../src/versions.js';
import { materialize } from '../src/materialize.js';

test('patch adds variable, undo/redo keeps hash and output consistent', () => {
  const template = '{{ greeting }}, {{ name }}!';
  const store = new VersionStore(template, { greeting: 'hi' });

  // v0: name undefined -> materialization fails, version unchanged
  assert.throws(() => materialize(store.template, store.variables), /undefined variable 'name'/);
  assert.equal(store.version, 0);

  // patch adds the variable -> v1 renders
  store.applyPatch({ set: { name: 'world' } });
  assert.equal(store.version, 1);
  const hash1 = store.hash;
  const out1 = materialize(store.template, store.variables).output;
  assert.equal(out1, 'hi, world!');

  // undo -> v0, redo -> v1: hash and output identical to first render
  store.undo();
  assert.equal(store.version, 0);
  assert.notEqual(store.hash, hash1);
  assert.throws(() => materialize(store.template, store.variables), /undefined variable/);

  store.redo();
  assert.equal(store.version, 1);
  assert.equal(store.hash, hash1);
  assert.equal(materialize(store.template, store.variables).output, out1);
});

test('versions are immutable snapshots; new patch drops redo tail', () => {
  const store = new VersionStore('{{ a }}', { a: 1 });
  store.applyPatch({ set: { a: 2 } });
  store.applyPatch({ set: { a: 3 } });
  const v1vars = store.versions[1];
  store.undo();
  store.undo();
  store.applyPatch({ set: { a: 9 } });
  assert.equal(store.versions.length, 2);
  assert.equal(store.variables.a, 9);
  assert.deepEqual(v1vars, { a: 2 }); // untouched
  assert.throws(() => { store.variables.a = 100; }, TypeError); // frozen
});

test('normalized hash is key-order independent', () => {
  assert.equal(
    normalizedHash('t', { a: 1, b: { c: 2, d: 3 } }),
    normalizedHash('t', { b: { d: 3, c: 2 }, a: 1 }),
  );
});
