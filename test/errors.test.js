'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { Store, StoreError } = require('../src/store');
const { tmpdir } = require('../testkit/helpers');

const CLI = path.join(__dirname, '..', 'bin', 'cli.js');

const DOCS = [
  { id: 'a', merchant: 'm1', amount: 10, tags: ['x'], status: 'settled', text: 'alpha beta gamma' },
];

function runCli(args, opts = {}) {
  return spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8', ...opts });
}

function seed() {
  const dir = tmpdir();
  const store = Store.open(dir);
  store.addRecords(DOCS);
  return dir;
}

function stateFingerprint(dir) {
  const files = fs.readdirSync(dir).sort();
  return files.map((f) => f + ':' + fs.readFileSync(path.join(dir, f)).toString('hex')).join('|');
}

function assertErrorEnvelope(res, code) {
  assert.equal(res.status, 1, `expected exit 1, got ${res.status}: ${res.stderr}`);
  const parsed = JSON.parse(res.stderr.trim());
  assert.ok(typeof parsed.error === 'string' && parsed.error.length > 0);
  assert.equal(parsed.code, code);
}

test('unknown id on delete/restore: exit 1, error envelope, state untouched', () => {
  const dir = seed();
  const before = stateFingerprint(dir);
  for (const cmd of ['delete', 'restore']) {
    const res = runCli([cmd, dir, 'no-such-id']);
    assertErrorEnvelope(res, 'UNKNOWN_ID');
  }
  assert.equal(stateFingerprint(dir), before);
});

test('invalid slop: exit 1, error envelope, state untouched', () => {
  const dir = seed();
  const before = stateFingerprint(dir);
  for (const slop of ['-1', 'abc', '1.5', '']) {
    const res = runCli(['query', dir, '--phrase', 'alpha beta', '--slop', slop]);
    assertErrorEnvelope(res, 'INVALID_SLOP');
  }
  assert.equal(stateFingerprint(dir), before);
});

test('corrupt JSON input: exit 1, error envelope, state untouched', () => {
  const dir = seed();
  const before = stateFingerprint(dir);
  const bad = path.join(dir, '..', `bad-${Date.now()}.jsonl`);
  fs.writeFileSync(bad, '{"id":"x","merchant":"m","amount":1,"tags":[],"text":"t","status":"s"}\n{"id":"y",oops\n');
  const res = runCli(['add', dir, bad]);
  assertErrorEnvelope(res, 'CORRUPT_JSON');
  fs.rmSync(bad, { force: true });
  assert.equal(stateFingerprint(dir), before);
  // store still queryable
  const q = runCli(['query', dir, '--phrase', 'alpha beta']);
  assert.equal(q.status, 0);
  assert.equal(JSON.parse(q.stdout).hits.length, 1);
});

test('duplicate id rejected without state change', () => {
  const dir = seed();
  const before = stateFingerprint(dir);
  const dup = path.join(dir, '..', `dup-${Date.now()}.jsonl`);
  fs.writeFileSync(dup, JSON.stringify(DOCS[0]) + '\n');
  const res = runCli(['add', dir, dup]);
  assertErrorEnvelope(res, 'DUPLICATE_ID');
  fs.rmSync(dup, { force: true });
  assert.equal(stateFingerprint(dir), before);
});

test('stdin add works through a shell pipe', () => {
  const dir = tmpdir();
  const rec = JSON.stringify({ id: 's1', merchant: 'm', amount: 3, tags: [], text: 'pipe fed text', status: 'settled' });
  const res = spawnSync('bash', ['-c', `printf '%s\\n' '${rec}' | node ${CLI} add ${dir} -`], { encoding: 'utf8' });
  assert.equal(res.status, 0, res.stderr);
  const q = runCli(['query', dir, '--phrase', 'pipe fed']);
  assert.equal(JSON.parse(q.stdout).hits[0].id, 's1');
});

test('library raises typed errors', () => {
  const store = Store.open(tmpdir());
  store.addRecords(DOCS);
  assert.throws(() => store.delete('nope'), (e) => e instanceof StoreError && e.code === 'UNKNOWN_ID');
  assert.throws(() => store.restore('nope'), (e) => e.code === 'UNKNOWN_ID');
  assert.throws(() => store.query('alpha', { slop: -1 }), (e) => e.code === 'INVALID_SLOP');
  assert.throws(() => store.query('alpha', { slop: 0.5 }), (e) => e.code === 'INVALID_SLOP');
});

test('corrupt records log fails load with CORRUPT_JSON', () => {
  const dir = seed();
  fs.appendFileSync(path.join(dir, 'records.jsonl'), '{broken\n');
  assert.throws(() => Store.open(dir), (e) => e.code === 'CORRUPT_JSON');
});
