import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpLogPath } from './helpers.js';

const CLI = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'cli.js');

function run(args) {
  // The sandbox swallows piped stdout of node child processes, so capture
  // output through files instead.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'evlog-cli-'));
  const outPath = path.join(dir, 'out.txt');
  const errPath = path.join(dir, 'err.txt');
  const outFd = fs.openSync(outPath, 'w');
  const errFd = fs.openSync(errPath, 'w');
  const res = spawnSync(process.execPath, [CLI, ...args], {
    stdio: ['ignore', outFd, errFd],
  });
  fs.closeSync(outFd);
  fs.closeSync(errFd);
  return {
    status: res.status,
    stdout: fs.readFileSync(outPath, 'utf8'),
    stderr: fs.readFileSync(errPath, 'utf8'),
  };
}

function ok(args) {
  const res = run(args);
  assert.equal(res.status, 0, `expected success, stderr: ${res.stderr}`);
  return JSON.parse(res.stdout);
}

test('CLI end-to-end: append, correct, view, history, certify, verify, revoke', () => {
  const file = tmpLogPath();

  assert.equal(ok(['append', file, '--device', 'pump-1', '--status', '0', '--payload', 'start', '--ts', '1000']).seq, 1);
  assert.equal(ok(['append', file, '--device', 'pump-1', '--status', '1', '--payload', 'run', '--ts', '1600']).seq, 2);

  let view = ok(['view', file]);
  assert.deepEqual(view.map((r) => [r.seq, r.status]), [[1, 0], [2, 1]]);

  assert.equal(ok(['correct', file, '--seq', '2', '--reason', 'sensor drift', '--status', '7', '--ts', '2000']).seq, 3);
  view = ok(['view', file]);
  assert.equal(view[1].status, 7);
  assert.equal(view[1].corrected, true);
  assert.equal(view[1].correctedBy, 3);

  const history = ok(['history', file]);
  assert.deepEqual(history.map((r) => r.type), ['event', 'event', 'correction']);
  assert.equal(history[2].reason, 'sensor drift');

  const cert = ok(['certify', file, '--seq', '2']);
  assert.equal(cert.targetSeq, 2);
  assert.equal(cert.activeSeq, 3);
  assert.deepEqual(ok(['verify', file, '--cert', JSON.stringify(cert)]), { ok: true });

  // Tampered certificate fails verification with a non-zero exit code.
  const bad = run(['verify', file, '--cert', JSON.stringify({ ...cert, activeSeq: 99 })]);
  assert.equal(bad.status, 1);
  assert.deepEqual(JSON.parse(bad.stdout), { ok: false });

  assert.equal(ok(['revoke', file, '--seq', '1', '--reason', 'duplicate', '--ts', '3000']).seq, 4);
  view = ok(['view', file]);
  assert.deepEqual(view.map((r) => r.seq), [2]);
});

test('CLI reports E_REVISION for corrections to unknown events', () => {
  const file = tmpLogPath();
  ok(['append', file, '--device', 'pump-1', '--status', '0', '--ts', '1000']);
  const res = run(['correct', file, '--seq', '42', '--reason', 'nope', '--status', '1']);
  assert.equal(res.status, 1);
  assert.match(res.stderr, /E_REVISION/);
});

test('CLI rebuild-index reproduces the same view after restart', () => {
  const file = tmpLogPath();
  ok(['append', file, '--device', 'a', '--status', '0', '--payload', 'x', '--ts', '100']);
  ok(['append', file, '--device', 'a', '--status', '1', '--payload', 'y', '--ts', '200']);
  ok(['correct', file, '--seq', '1', '--reason', 'fix', '--status', '9', '--ts', '300']);
  const before = ok(['view', file]);

  const rebuilt = ok(['rebuild-index', file]);
  assert.equal(rebuilt.ok, true);
  assert.equal(rebuilt.entries, 3);

  assert.deepEqual(ok(['view', file]), before);
});
