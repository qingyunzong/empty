import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { tmpdir } from '../testlib/helpers.js';

const CLI = fileURLToPath(new URL('../src/cli.js', import.meta.url));

// Note: this sandbox swallows grandchild pipe output, so capture via files.
function run(args, dir) {
  const outFile = fs.mkdtempSync(path.join(os.tmpdir(), 'cli-out-'));
  const outPath = path.join(outFile, 'stdout');
  const errPath = path.join(outFile, 'stderr');
  const outFd = fs.openSync(outPath, 'w');
  const errFd = fs.openSync(errPath, 'w');
  const res = spawnSync(process.execPath, [CLI, '--data', dir, ...args], {
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

test('CLI end-to-end: apply/replay/audit/checkpoint/inject', () => {
  const dir = tmpdir();

  let res = run(['apply', '--key', 't/1', '--device', 'dev-A', '--value', '{"v":12.5}'], dir);
  assert.equal(res.status, 0, res.stderr);
  assert.equal(JSON.parse(res.stdout).applied.txn, 1);

  res = run(['apply', '--key', 't/2', '--device', 'dev-A', '--value', '42'], dir);
  assert.equal(res.status, 0, res.stderr);
  res = run(['apply', '--key', 't/1', '--delete'], dir);
  assert.equal(res.status, 0, res.stderr);

  res = run(['replay', '--to', '1'], dir);
  assert.equal(res.status, 0, res.stderr);
  assert.deepEqual(JSON.parse(res.stdout).state, { 't/1': { value: { v: 12.5 }, deviceId: 'dev-A' } });

  res = run(['replay', '--to', '3'], dir);
  assert.deepEqual(JSON.parse(res.stdout).state, { 't/2': { value: 42, deviceId: 'dev-A' } });

  // NO_SUCH_TXN -> exit code 2, machine-readable code on stderr.
  res = run(['replay', '--to', '99'], dir);
  assert.equal(res.status, 2);
  assert.match(res.stderr, /NO_SUCH_TXN/);

  res = run(['checkpoint'], dir);
  assert.equal(res.status, 0, res.stderr);
  assert.equal(JSON.parse(res.stdout).checkpoint.txn, 3);
  assert.ok(fs.existsSync(path.join(dir, 'checkpoints', '3.json')));

  res = run(['audit'], dir);
  assert.equal(res.status, 0, res.stderr);
  assert.equal(JSON.parse(res.stdout).ok, true);

  // Sabotage the index -> audit exits 4 and reports the divergence.
  const indexPath = path.join(dir, 'index.json');
  const index = JSON.parse(fs.readFileSync(indexPath, 'utf8'));
  index['dev-A'].push('ghost');
  fs.writeFileSync(indexPath, JSON.stringify(index));
  res = run(['audit'], dir);
  assert.equal(res.status, 4);
  const report = JSON.parse(res.stdout);
  assert.equal(report.ok, false);
  assert.ok(report.divergences.some((d) => d.key === 'ghost' && d.kind === 'stale-in-index'));
});

test('CLI inject: truncate mid-log, recover via checkpoint, continue', () => {
  const dir = tmpdir();
  for (let i = 1; i <= 10; i++) {
    const res = run(['apply', '--key', `k${i}`, '--device', 'd', '--value', String(i)], dir);
    assert.equal(res.status, 0, res.stderr);
  }
  // Find the offset of record #8 and truncate inside it.
  const walPath = path.join(dir, 'wal.log');
  const buf = fs.readFileSync(walPath);
  let offset = 0;
  for (let i = 0; i < 7; i++) offset += 8 + buf.readUInt32LE(offset);
  const res1 = run(['inject', 'truncate', '--offset', String(offset + 4)], dir);
  assert.equal(res1.status, 0, res1.stderr);

  // Replay before the cut works; at/after the cut reports CHECKSUM_MISMATCH (exit 3).
  let res = run(['replay', '--to', '7'], dir);
  assert.equal(res.status, 0, res.stderr);
  assert.equal(Object.keys(JSON.parse(res.stdout).state).length, 7);
  res = run(['replay', '--to', '8'], dir);
  assert.equal(res.status, 3);
  assert.match(res.stderr, new RegExp(`CHECKSUM_MISMATCH.*offset ${offset}`));

  // Recovery happens on the write path; then the log continues cleanly.
  res = run(['checkpoint'], dir);
  assert.equal(res.status, 0, res.stderr);
  assert.match(res.stderr, /RECOVERY: truncated WAL/);
  assert.equal(JSON.parse(res.stdout).checkpoint.txn, 7);
  res = run(['apply', '--key', 'k8', '--device', 'd', '--value', '8'], dir);
  assert.equal(JSON.parse(res.stdout).applied.txn, 8);
  res = run(['replay', '--to', '8'], dir);
  assert.equal(res.status, 0, res.stderr);
});

test('CLI apply --inject exits 75 and the store recovers', () => {
  const dir = tmpdir();
  let res = run(['apply', '--key', 'a', '--device', 'd', '--value', '1'], dir);
  assert.equal(res.status, 0, res.stderr);
  res = run(['apply', '--key', 'b', '--device', 'd', '--value', '2', '--inject', 'after-fsync'], dir);
  assert.equal(res.status, 75);
  assert.match(res.stderr, /INJECTED_CRASH at after-fsync/);
  res = run(['replay', '--to', '2'], dir);
  assert.equal(res.status, 0, res.stderr);
  assert.deepEqual(JSON.parse(res.stdout).state, {
    a: { value: 1, deviceId: 'd' },
    b: { value: 2, deviceId: 'd' },
  });
});

test('CLI corrupt-byte: replay reports CHECKSUM_MISMATCH with offset (exit 3)', () => {
  const dir = tmpdir();
  for (let i = 1; i <= 5; i++) {
    const r = run(['apply', '--key', `k${i}`, '--device', 'd', '--value', String(i)], dir);
    assert.equal(r.status, 0, r.stderr);
  }
  const walPath = path.join(dir, 'wal.log');
  const buf = fs.readFileSync(walPath);
  let offset = 0;
  for (let i = 0; i < 2; i++) offset += 8 + buf.readUInt32LE(offset); // record #3
  const res1 = run(['inject', 'corrupt-byte', '--offset', String(offset + 9)], dir);
  assert.equal(res1.status, 0, res1.stderr);
  const res = run(['replay', '--to', '5'], dir);
  assert.equal(res.status, 3);
  assert.match(res.stderr, new RegExp(`CHECKSUM_MISMATCH.*offset ${offset}`));
});
