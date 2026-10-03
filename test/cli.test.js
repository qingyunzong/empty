import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { tmpdir, runCli } from '../support/helpers.js';

test('cli: put -> replace -> materialize -> history -> verify', () => {
  const store = tmpdir();
  let r = runCli(['put', '--id', 'T1', '--price', '100', '--qty', '10', '--author', 'alice'], { store });
  assert.equal(r.code, 0, r.stderr);
  assert.equal(r.json.ok, true);
  const base = r.json.hash;

  r = runCli(['replace', '--id', 'T1', '--price', '110', '--author', 'bob'], { store });
  assert.equal(r.code, 0);
  assert.equal(r.json.status, 'ok');

  r = runCli(['materialize', '--id', 'T1'], { store });
  assert.equal(r.code, 0);
  assert.deepEqual(r.json.state, { price: 110, quantity: 10, status: 'active' });
  assert.equal(r.json.margin.frozen, 110);

  r = runCli(['history', '--id', 'T1'], { store });
  assert.equal(r.code, 0);
  assert.equal(r.json.revisions.length, 2);
  assert.equal(r.json.revisions[0].hash, base);

  r = runCli(['verify'], { store });
  assert.equal(r.code, 0);
  assert.equal(r.json.ok, true);
  assert.equal(r.json.records, 2);
});

test('cli: same-field conflict exits 2, resolve unblocks', () => {
  const store = tmpdir();
  let r = runCli(['put', '--id', 'T1', '--price', '100', '--qty', '10'], { store });
  const base = r.json.hash;
  runCli(['replace', '--id', 'T1', '--price', '101'], { store });

  r = runCli(['replace', '--id', 'T1', '--base', base, '--price', '105'], { store });
  assert.equal(r.code, 2);
  assert.equal(r.json.ok, false);
  assert.equal(r.json.error.code, 'CONFLICT');
  assert.equal(r.json.error.heads.length, 2);

  r = runCli(['materialize', '--id', 'T1'], { store });
  assert.equal(r.code, 2);
  assert.equal(r.json.error.code, 'CONFLICT');

  const winner = r.json.error.heads[0].hash;
  r = runCli(['resolve', '--id', 'T1', '--winner', winner], { store });
  assert.equal(r.code, 0);
  assert.equal(r.json.status, 'resolved');

  r = runCli(['materialize', '--id', 'T1'], { store });
  assert.equal(r.code, 0);
  assert.equal(r.json.state.status, 'active');
});

test('cli: disjoint concurrent edits auto-merge with exit 0', () => {
  const store = tmpdir();
  let r = runCli(['put', '--id', 'T1', '--price', '100', '--qty', '10'], { store });
  const base = r.json.hash;
  runCli(['replace', '--id', 'T1', '--price', '101'], { store });
  r = runCli(['replace', '--id', 'T1', '--base', base, '--qty', '25'], { store });
  assert.equal(r.code, 0);
  assert.equal(r.json.status, 'merged');
  r = runCli(['materialize', '--id', 'T1'], { store });
  assert.deepEqual(r.json.state, { price: 101, quantity: 25, status: 'active' });
});

test('cli: cancel then modify is rejected with exit 1', () => {
  const store = tmpdir();
  runCli(['put', '--id', 'T1', '--price', '100', '--qty', '10'], { store });
  let r = runCli(['cancel', '--id', 'T1'], { store });
  assert.equal(r.code, 0);
  r = runCli(['replace', '--id', 'T1', '--price', '1'], { store });
  assert.equal(r.code, 1);
  assert.equal(r.json.error.code, 'CANCELLED');
  r = runCli(['materialize', '--id', 'T1'], { store });
  assert.equal(r.json.margin.frozen, 0);
});

test('cli: verify --rebuild after index deletion and corruption', () => {
  const store = tmpdir();
  runCli(['put', '--id', 'T1', '--price', '100', '--qty', '10'], { store });
  runCli(['replace', '--id', 'T1', '--qty', '30'], { store });

  fs.rmSync(path.join(store, 'index.json'));
  let r = runCli(['verify'], { store });
  assert.equal(r.code, 1);
  assert.equal(r.json.error ? r.json.error.code : r.json.code, 'INDEX_MISSING');

  r = runCli(['verify', '--rebuild'], { store });
  assert.equal(r.code, 0);
  assert.equal(r.json.rebuilt, true);

  fs.writeFileSync(path.join(store, 'index.json'), 'not json at all{{{');
  r = runCli(['verify'], { store });
  assert.equal(r.code, 1);
  r = runCli(['verify', '--rebuild'], { store });
  assert.equal(r.code, 0);
  assert.equal(r.json.ok, true);
});

test('cli: unknown command and missing args exit 1 with JSON error', () => {
  const store = tmpdir();
  let r = runCli(['frobnicate'], { store });
  assert.equal(r.code, 1);
  assert.equal(r.json.ok, false);
  r = runCli(['put', '--id', 'T1'], { store });
  assert.equal(r.code, 1);
  assert.equal(r.json.error.code, 'MISSING_ARG');
});
