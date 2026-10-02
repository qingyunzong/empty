import test from 'node:test';
import assert from 'node:assert/strict';
import { materialize } from '../src/materialize.js';
import { VersionStore } from '../src/versions.js';
import { runCli } from '../src/cli.js';

// NOTE: the sandbox forbids spawning child processes (EPERM), so the CLI is
// exercised in-process via runCli(); end-to-end stdin/stdout behavior was
// verified manually: echo '{...}' | node src/cli.js

test('deep missing field fails the whole materialization with no partial output', () => {
  const template = 'BEGIN:{{ user.profile.contact.email }}:END';
  const variables = { user: { profile: {} } };
  assert.throws(
    () => materialize(template, variables),
    (err) => {
      assert.equal(err.phase, 'render');
      assert.match(err.message, /missing field 'contact'/);
      return true;
    },
  );
  // render() never returns on failure, so no partial 'BEGIN:' can escape.
});

test('unclosed block fails at compile time', () => {
  assert.throws(() => materialize('{% scope x = 1 %}{{ x }}', { x: 0 }), /unclosed block: scope 'x'/);
});

test('unsupported filter type fails', () => {
  assert.throws(() => materialize('{{ 1 | upper }}', {}), /filter 'upper' does not support type number/);
});

test('CLI: deep missing field -> exit 1, payload has no partial rendered text', () => {
  const { code, payload } = runCli({
    template: 'BEGIN:{{ user.profile.contact.email }}:END',
    variables: { user: { profile: {} } },
    patches: [],
  });
  assert.equal(code, 1);
  const line = JSON.stringify(payload);
  assert.equal(payload.ok, false);
  assert.equal(payload.version, 0);
  assert.match(payload.error, /missing field 'contact'/);
  assert.ok(!line.includes('BEGIN:'), 'stdout payload must not contain partial rendered output');
  assert.ok(!('output' in payload), 'failure payload must not carry an output field');
});

test('CLI: patch sequence with undo/redo renders final version', () => {
  const { code, payload } = runCli({
    template: '{{ a }}-{{ b }}',
    variables: { a: 'A' },
    patches: [{ set: { b: 'B1' } }, { set: { b: 'B2' } }, { op: 'undo' }],
  });
  assert.equal(code, 0);
  assert.equal(payload.ok, true);
  assert.equal(payload.version, 1);
  assert.equal(payload.output, 'A-B1');
});

test('failed materialization leaves current patch version unchanged', () => {
  const store = new VersionStore('{{ ok }}', { ok: 'v0' });
  store.applyPatch({ set: { ok: 'v1' } });
  assert.equal(store.version, 1);
  assert.throws(() => materialize('{{ missing.deep.field }}', store.variables), /undefined variable 'missing'/);
  assert.equal(store.version, 1);
  assert.equal(store.variables.ok, 'v1');
});
