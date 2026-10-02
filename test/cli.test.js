'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { run } = require('../src/cli');

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'settle-cli-'));
}

function cli(dir, args) {
  const out = [];
  const err = [];
  const origLog = console.log;
  const origErr = console.error;
  console.log = (...a) => out.push(a.join(' '));
  console.error = (...a) => err.push(a.join(' '));
  let code;
  try {
    code = run(['--data', dir, ...args]);
  } finally {
    console.log = origLog;
    console.error = origErr;
  }
  return { code, stdout: out.join('\n'), stderr: err.join('\n') };
}

test('happy path: propose/finalize/state/verify exit 0', () => {
  const dir = tmpDir();
  let r = cli(dir, ['propose', '--batch', 'b1', '--transfer', 't1:A:B:10', '--budget', 'A:100']);
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /PROPOSED batch=b1/);

  r = cli(dir, ['finalize', '--batch', 'b1']);
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /FINALIZED batch=b1 level=0/);
  assert.match(r.stdout, /settled=\[t1\]/);

  r = cli(dir, ['state']);
  assert.equal(r.code, 0);
  assert.match(r.stdout, /batch=b1 .*status=final/);
  assert.match(r.stdout, /net A=10 B=-10/);

  r = cli(dir, ['verify']);
  assert.equal(r.code, 0);
  assert.match(r.stdout, /OK/);
});

test('business conflicts exit 1', () => {
  const dir = tmpDir();
  // finalize without proposal
  let r = cli(dir, ['finalize', '--batch', 'ghost']);
  assert.equal(r.code, 1);
  assert.match(r.stderr, /CONFLICT/);

  // duplicate proposal
  cli(dir, ['propose', '--batch', 'b1', '--transfer', 't1:A:B:10']);
  r = cli(dir, ['propose', '--batch', 'b1', '--transfer', 't1:A:B:10']);
  assert.equal(r.code, 1);

  // rollback of unknown batch
  r = cli(dir, ['rollback', '--batch', 'nope']);
  assert.equal(r.code, 1);

  // unknown command
  r = cli(dir, ['frobnicate']);
  assert.equal(r.code, 1);
});

test('correct via CLI rolls back dependents and keeps siblings', () => {
  const dir = tmpDir();
  cli(dir, ['propose', '--batch', 'b1', '--transfer', 't1:A:B:10', '--budget', 'A:100']);
  cli(dir, ['finalize', '--batch', 'b1']);
  cli(dir, ['propose', '--batch', 'b2', '--transfer', 't2:B:C:10', '--budget', 'B:100']);
  cli(dir, ['finalize', '--batch', 'b2', '--parent', 'b1']);
  cli(dir, ['propose', '--batch', 'b3', '--transfer', 't3:C:D:10', '--budget', 'C:100']);
  cli(dir, ['finalize', '--batch', 'b3', '--parent', 'b2']);
  cli(dir, ['propose', '--batch', 'b4', '--transfer', 't4:D:A:5', '--budget', 'D:100']);
  cli(dir, ['finalize', '--batch', 'b4', '--parent', 'b1']);

  const r = cli(dir, ['correct', '--batch', 'b2', '--transfer', 't2x:B:C:7', '--budget', 'B:100']);
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /CORRECTED batch=b2 level=1/);
  assert.match(r.stdout, /rolledBack=\[b3\]/);

  const s = cli(dir, ['state']);
  assert.match(s.stdout, /batch=b3 .*status=rolledback/);
  assert.match(s.stdout, /batch=b4 .*status=final/);
  const b2lines = s.stdout.split('\n').filter((l) => l.includes('batch=b2'));
  assert.equal(b2lines.length, 2);
  assert.ok(b2lines.some((l) => l.includes('status=corrected')));
  assert.ok(b2lines.some((l) => l.includes('status=final')));
});

test('corruption exits 2 on verify and on operational commands', () => {
  const dir = tmpDir();
  cli(dir, ['propose', '--batch', 'b1', '--transfer', 't1:A:B:10', '--budget', 'A:100']);
  cli(dir, ['finalize', '--batch', 'b1']);

  const chunksDir = path.join(dir, 'chunks');
  const file = path.join(chunksDir, fs.readdirSync(chunksDir)[0]);
  const tampered = JSON.parse(fs.readFileSync(file, 'utf8'));
  tampered.transfers = ['evil'];
  fs.writeFileSync(file, JSON.stringify(tampered, null, 2));

  let r = cli(dir, ['verify']);
  assert.equal(r.code, 2);
  assert.match(r.stdout, /CORRUPT/);

  r = cli(dir, ['state']);
  assert.equal(r.code, 2, 'operational commands refuse a corrupt store');
});
