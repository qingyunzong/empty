'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs');
const { run } = require('../bin/kvx.js');
const { tmpdir } = require('./helpers');

// Invoke the CLI in-process, capturing output and the exit code.
function cli(args) {
  const out = [];
  const err = [];
  const code = run(args, { out: (s) => out.push(s), err: (s) => err.push(s) });
  return { status: code, stdout: out.join('\n'), stderr: err.join('\n') };
}

test('CLI end-to-end: commit/export/import/check/replay across two replicas', () => {
  const dA = path.join(tmpdir(), 'a');
  const dB = path.join(tmpdir(), 'b');

  let r = cli(['commit', '--db', dA, '--node', 'A', '--write', 'alice=100']);
  assert.equal(r.status, 0, r.stderr);
  const rec = JSON.parse(r.stdout);
  assert.equal(rec.id, 'A:1');
  assert.deepEqual(rec.clock, { A: 1 });

  r = cli(['commit', '--db', dA, '--read', 'alice', '--write', 'alice=150']);
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(JSON.parse(r.stdout).reads, { alice: '100' });

  r = cli(['commit', '--db', dB, '--node', 'B', '--write', 'bob=50']);
  assert.equal(r.status, 0, r.stderr);

  const segA = path.join(tmpdir(), 'a.log');
  const segB = path.join(tmpdir(), 'b.log');
  assert.equal(cli(['export', '--db', dA, '--out', segA]).status, 0);
  assert.equal(cli(['export', '--db', dB, '--out', segB]).status, 0);

  r = cli(['import', '--db', dB, '--file', segA]);
  assert.match(r.stdout, /^OK imported=2 duplicates=0/);
  r = cli(['import', '--db', dB, '--file', segA]); // idempotent
  assert.match(r.stdout, /^OK imported=0 duplicates=2/);
  r = cli(['import', '--db', dA, '--file', segB]);
  assert.match(r.stdout, /^OK imported=1/);

  r = cli(['read', '--db', dA, '--key', 'bob']);
  assert.equal(r.stdout.trim(), '50');
  r = cli(['read', '--db', dA, '--key', 'nobody']);
  assert.equal(r.stdout.trim(), '(absent)');
  // snapshot read at the first commit's clock
  r = cli(['read', '--db', dA, '--key', 'alice', '--at', '{"A":1}']);
  assert.equal(r.stdout.trim(), '100');

  r = cli(['check', '--db', dA]);
  assert.equal(r.status, 0, r.stdout);
  assert.match(r.stdout, /SERIALIZABLE/);

  r = cli(['replay', '--db', dA]);
  assert.equal(r.status, 0, r.stdout);
  assert.match(r.stdout, /REPLAY OK/);
  assert.match(r.stdout, /"alice":"150"/);
  assert.match(r.stdout, /"bob":"50"/);
});

test('CLI: conflicting merge exits 1 with a cycle', () => {
  const dA = path.join(tmpdir(), 'a');
  const dB = path.join(tmpdir(), 'b');
  cli(['commit', '--db', dA, '--node', 'A', '--read', 'y', '--write', 'x=1']);
  cli(['commit', '--db', dB, '--node', 'B', '--read', 'x', '--write', 'y=1']);
  const segA = path.join(tmpdir(), 'a.log');
  const segB = path.join(tmpdir(), 'b.log');
  cli(['export', '--db', dA, '--out', segA]);
  cli(['export', '--db', dB, '--out', segB]);
  cli(['import', '--db', dA, '--file', segB]);

  const r = cli(['check', '--db', dA]);
  assert.equal(r.status, 1);
  assert.match(r.stdout, /NON_SERIALIZABLE/);
  assert.match(r.stdout, /cycle: A:1 -> B:1 -> A:1|cycle: B:1 -> A:1 -> B:1/);

  const rp = cli(['replay', '--db', dA]);
  assert.equal(rp.status, 1);
});

test('CLI: corrupt segment reports CORRUPT and skips bad lines', () => {
  const dA = path.join(tmpdir(), 'a');
  const dB = path.join(tmpdir(), 'b');
  cli(['commit', '--db', dA, '--node', 'A', '--write', 'x=1']);
  cli(['commit', '--db', dA, '--node', 'A', '--write', 'y=2']);
  const seg = path.join(tmpdir(), 'a.log');
  cli(['export', '--db', dA, '--out', seg]);
  const lines = fs.readFileSync(seg, 'utf8').trim().split('\n');
  lines[0] = lines[0].replace('"x":"1"', '"x":"9"'); // tamper
  const bad = path.join(tmpdir(), 'bad.log');
  fs.writeFileSync(bad, lines.join('\n') + '\n');
  const r = cli(['import', '--db', dB, '--file', bad]);
  assert.equal(r.status, 0);
  assert.match(r.stdout, /^CORRUPT imported=1 duplicates=0 skipped=1/);
  const rd = cli(['read', '--db', dB, '--key', 'y']);
  assert.equal(rd.stdout.trim(), '2');
});
