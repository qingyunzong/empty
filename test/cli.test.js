import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runCli } from '../src/cli.js';

function tmpdir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'qrec-cli-'));
}

function run(args) {
  const stdout = [];
  const stderr = [];
  const status = runCli(args, {
    out: (line) => stdout.push(line),
    err: (line) => stderr.push(line),
  });
  return { status, stdout: stdout.join('\n'), stderr: stderr.join('\n') };
}

test('cli end-to-end: create/add/show/correct/audit/locate/verify', () => {
  const dir = tmpdir();
  let r = run(['create', dir, 'B1', '--baseline', '100', '--tolerance', '0.5', '--time', '1000']);
  assert.equal(r.status, 0, r.stderr);

  r = run(['add', dir, 'B1', '--value', '100.2', '--time', '2000']);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /seq=1/);

  r = run(['add', dir, 'B1', '--value', '101.2', '--time', '3000']);
  assert.equal(r.status, 0, r.stderr);

  r = run(['show', dir, 'B1']);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /judgment: FAIL/);
  assert.match(r.stdout, /failures: 2/);

  r = run([
    'correct', dir, 'B1', '--seq', '2', '--value', '100.1',
    '--reason', 'recalibrated', '--time', '4000',
  ]);
  assert.equal(r.status, 0, r.stderr);

  r = run(['show', dir, 'B1']);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /judgment: PASS/);
  assert.match(r.stdout, /recalibrated/);
  assert.match(r.stdout, /\[superseded\]/);

  // audit replays only the first 3 records (baseline + 2 measurements)
  r = run(['audit', dir, 'B1', '--records', '3']);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /judgment: FAIL/);

  r = run(['locate', dir, 'B1', '--time', '2500']);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /100\.2/);

  r = run(['verify', dir]);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /verify: OK/);

  r = run(['show', dir, 'B1', '--json']);
  assert.equal(r.status, 0, r.stderr);
  const parsed = JSON.parse(r.stdout);
  assert.equal(parsed.judgment.pass, true);
  assert.equal(parsed.corrections[0].reason, 'recalibrated');
});

test('cli reports E_CRC with exit code 3 on corrupted chunk', () => {
  const dir = tmpdir();
  assert.equal(run(['create', dir, 'B', '--baseline', '0', '--tolerance', '1', '--time', '1']).status, 0);
  assert.equal(run(['add', dir, 'B', '--value', '0.1', '--time', '2']).status, 0);

  const chunksDir = path.join(dir, 'chunks');
  const files = fs.readdirSync(chunksDir).filter((f) => f.endsWith('.bin')).sort();
  const target = path.join(chunksDir, files[files.length - 1]);
  const buf = fs.readFileSync(target);
  buf[buf.length - 6] ^= 0xff;
  fs.writeFileSync(target, buf);

  const r = run(['verify', dir]);
  assert.equal(r.status, 3, `stdout=${r.stdout} stderr=${r.stderr}`);
  assert.match(r.stderr, /E_CRC/);

  // show still works non-strictly and warns
  const s = run(['show', dir, 'B']);
  assert.equal(s.status, 0, s.stderr);
  assert.match(s.stderr, /E_CRC/);
});

test('cli reports E_REFERENCE with exit code 4', () => {
  const dir = tmpdir();
  assert.equal(run(['create', dir, 'B', '--baseline', '0', '--tolerance', '1', '--time', '1']).status, 0);
  assert.equal(run(['add', dir, 'B', '--value', '0.1', '--time', '2']).status, 0);
  const r = run(['correct', dir, 'B', '--seq', '9', '--value', '0.2', '--reason', 'nope']);
  assert.equal(r.status, 4, `stdout=${r.stdout} stderr=${r.stderr}`);
  assert.match(r.stderr, /E_REFERENCE/);
});

test('cli usage errors exit with code 2', () => {
  const r = run(['frobnicate']);
  assert.equal(r.status, 2);
  const r2 = run(['create']);
  assert.equal(r2.status, 2);
});
