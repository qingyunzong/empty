import test from 'node:test';
import assert from 'node:assert/strict';
import { VersionStore } from '../src/versions.js';
import { materialize } from '../src/engine.js';

test('patch adds a variable; undo and redo keep hash and output consistent', () => {
  const store = new VersionStore('Hello, {{ name }}!', {});
  assert.equal(store.version, 0);

  store.applyPatch({ op: 'set', name: 'name', value: 'world' });
  assert.equal(store.version, 1);

  const first = materialize(store.current().template, store.current().variables);
  const firstStateHash = store.stateHash();
  assert.equal(first.output, 'Hello, world!');

  store.undo();
  assert.equal(store.version, 0);
  assert.throws(
    () => materialize(store.current().template, store.current().variables),
    (err) => err.code === 'UNDEFINED_VARIABLE',
  );

  store.redo();
  assert.equal(store.version, 1);
  const second = materialize(store.current().template, store.current().variables);
  assert.equal(second.output, first.output);
  assert.equal(second.hash, first.hash);
  assert.equal(store.stateHash(), firstStateHash);
});

test('versions are immutable snapshots', () => {
  const store = new VersionStore('{{ a }}', { a: 1 });
  store.applyPatch({ op: 'set', name: 'a', value: 2 });
  assert.throws(() => {
    store.current().variables.a = 99;
  }, TypeError);
  store.undo();
  assert.equal(store.current().variables.a, 1);
  store.redo();
  assert.equal(store.current().variables.a, 2);
});

test('invalid patch is rejected without changing the version', () => {
  const store = new VersionStore('{{ a }}', { a: 1 });
  assert.throws(() => store.applyPatch({ op: 'explode' }), (err) => err.code === 'INVALID_PATCH');
  assert.equal(store.version, 0);
  assert.equal(store.length, 1);
});

test('applying a patch after undo truncates the redo branch', () => {
  const store = new VersionStore('{{ a }}', { a: 1 });
  store.applyPatch({ op: 'set', name: 'a', value: 2 });
  store.undo();
  store.applyPatch({ op: 'set', name: 'a', value: 3 });
  assert.equal(store.version, 1);
  assert.equal(store.length, 2);
  assert.equal(store.current().variables.a, 3);
  store.redo();
  assert.equal(store.version, 1);
});
