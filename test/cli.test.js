'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { run } = require('../cli');

function tmpdir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'credit-replica-'));
}

test('cli: reserve, balance, limit-exceeded error contract', () => {
  const dir = tmpdir();
  const file = path.join(dir, 'a.json');

  let r = run(['reserve', file, 'r1', 'alice', '400', '--limit', '500']);
  assert.equal(r.code, 0);
  assert.equal(r.json.ok, true);
  assert.equal(r.json.balance.available, 100);

  r = run(['balance', file]);
  assert.equal(r.code, 0);
  assert.deepEqual(r.json, {
    limit: 500,
    reserved: 400,
    released: 0,
    outstanding: 400,
    available: 100,
  });

  r = run(['reserve', file, 'r2', 'bob', '200']);
  assert.equal(r.code, 1);
  assert.deepEqual(r.json, { error: 'limit-exceeded' });

  r = run(['reserve', file, 'r1', 'alice', '400']);
  assert.equal(r.code, 0);
  assert.equal(r.json.applied, false, 'idempotent replay');
});

test('cli: release, over-release, tombstone on duplicate', () => {
  const dir = tmpdir();
  const file = path.join(dir, 'a.json');

  run(['reserve', file, 'r1', 'alice', '300']);
  let r = run(['release', file, 'x1', 'r1', '120']);
  assert.equal(r.code, 0);
  assert.equal(r.json.balance.available, 1000 - 300 + 120);

  r = run(['release', file, 'x2', 'r1', '181']);
  assert.equal(r.code, 1);
  assert.deepEqual(r.json, { error: 'over-release' });

  r = run(['release', file, 'x1', 'r1', '120']);
  assert.equal(r.code, 0);
  assert.equal(r.json.applied, false, 'tombstone blocks stale duplicate');

  r = run(['release', file, 'x1', 'r1', '100']);
  assert.equal(r.code, 1);
  assert.deepEqual(r.json, { error: 'payload-conflict' });
});

test('cli: diff and repair converge two replicas', () => {
  const dir = tmpdir();
  const fileA = path.join(dir, 'a.json');
  const fileB = path.join(dir, 'b.json');

  run(['reserve', fileA, 'r-a', 'alice', '400']);
  run(['reserve', fileB, 'r-b', 'bob', '300']);
  run(['release', fileA, 'x-a', 'r-a', '100']);

  let r = run(['diff', fileA, fileB]);
  assert.equal(r.code, 0);
  assert.deepEqual(
    r.json.missing.map((e) => e.requestId).sort(),
    ['r-a', 'x-a'],
  );

  r = run(['repair', fileA, fileB]);
  assert.equal(r.code, 0);
  assert.deepEqual(r.json.merged, ['reserve:r-b']);
  r = run(['repair', fileB, fileA]);
  assert.equal(r.code, 0);
  assert.deepEqual(r.json.merged.sort(), ['release:x-a', 'reserve:r-a']);

  const balA = run(['balance', fileA]).json;
  const balB = run(['balance', fileB]).json;
  assert.deepEqual(balA, balB);
  assert.equal(balA.available, 1000 - 700 + 100);

  const digestA = run(['diff', fileA, fileA]).json.digest;
  const digestB = run(['diff', fileB, fileB]).json.digest;
  assert.equal(digestA, digestB);
});

test('cli: unknown command and missing file errors', () => {
  const dir = tmpdir();
  let r = run(['bogus']);
  assert.equal(r.code, 1);
  assert.deepEqual(r.json, { error: 'unknown-command' });

  r = run(['balance', path.join(dir, 'nope.json')]);
  assert.equal(r.code, 1);
  assert.deepEqual(r.json, { error: 'not-found' });
});
