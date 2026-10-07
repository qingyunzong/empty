'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { runCli } = require('../cli');
const { sha256 } = require('../src/archive');

function tmpdir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'archive-cli-'));
}

function run(dir, args) {
  let out = '';
  let err = '';
  const status = runCli([...args, '--dir', dir], {
    stdout: (s) => { out += s; },
    stderr: (s) => { err += s; },
  });
  return { status, stdout: out, stderr: err };
}

test('CLI happy path: request/restore/verify exit 0 with placement, slices, certificates', () => {
  const dir = tmpdir();
  let r = run(dir, ['request', '--id', 'a', '--size', '8', '--retention', '5', '--requester', 'r1']);
  assert.equal(r.status, 0, r.stderr);
  r = run(dir, ['restore']);
  assert.equal(r.status, 0, r.stderr);
  const out = JSON.parse(r.stdout);
  assert.deepEqual(out.placement, [{ id: 'a', offset: 0, size: 8 }]);
  assert.ok(out.slices.length >= 1);
  assert.equal(out.certificates.length, 1);
  r = run(dir, ['verify']);
  assert.equal(r.status, 0, r.stderr);
  const report = JSON.parse(r.stdout);
  assert.equal(report.ok, true);
  assert.equal(report.chainOk, true);
});

test('CLI cyclic dependency exits 11', () => {
  const dir = tmpdir();
  run(dir, ['request', '--id', 'x', '--size', '5', '--retention', '1', '--requester', 'r']);
  run(dir, ['request', '--id', 'y', '--size', '5', '--retention', '1', '--requester', 'r', '--parent', 'x']);
  // create the cycle by hand in the persisted state
  const file = path.join(dir, 'state.json');
  const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
  saved.state.objects.x.parent = 'y';
  fs.writeFileSync(file, JSON.stringify(saved));
  const r = run(dir, ['restore']);
  assert.equal(r.status, 11, r.stderr);
  assert.match(r.stderr, /CYCLE/);
});

test('CLI disk full exits 11', () => {
  const dir = tmpdir();
  run(dir, ['request', '--id', 'huge', '--size', '5000', '--retention', '9', '--requester', 'r']);
  const r = run(dir, ['restore', '--capacity', '10']);
  assert.equal(r.status, 11, r.stderr);
  const out = JSON.parse(r.stdout);
  assert.deepEqual(out.failures, [{ id: 'huge', reason: 'disk-full' }]);
});

test('CLI checksum error exits 11 and correct repairs it', () => {
  const dir = tmpdir();
  run(dir, ['request', '--id', 'a', '--size', '5', '--retention', '5', '--requester', 'r']);
  run(dir, ['restore']);
  run(dir, ['correct', '--id', 'a', '--checksum', 'f'.repeat(64)]);
  let r = run(dir, ['verify']);
  assert.equal(r.status, 11, r.stderr);
  const bad = JSON.parse(r.stdout);
  assert.deepEqual(bad.failures, ['a']);
  run(dir, ['correct', '--id', 'a', '--checksum', sha256('a')]);
  r = run(dir, ['verify']);
  assert.equal(r.status, 0, r.stderr);
});

test('CLI fault injection rolls back and undo reverts generations', () => {
  const dir = tmpdir();
  run(dir, ['request', '--id', 'a', '--size', '5', '--retention', '5', '--requester', 'r']);
  const fault = run(dir, ['restore', '--fail-at', 'index']);
  assert.equal(fault.status, 1);
  assert.match(fault.stderr, /FAULT/);
  let r = run(dir, ['verify']);
  assert.equal(JSON.parse(r.stdout).objects[0].status, 'pending');
  r = run(dir, ['restore']);
  assert.equal(r.status, 0);
  r = run(dir, ['undo']);
  assert.equal(r.status, 0);
  r = run(dir, ['verify']);
  assert.equal(JSON.parse(r.stdout).objects[0].status, 'pending');
});
