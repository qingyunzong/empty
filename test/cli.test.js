import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const CLI = fileURLToPath(new URL('../src/cli.js', import.meta.url));

function tmpdir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'evidence-cli-'));
}

// Note: pipes to grandchild node processes are unreliable in some sandboxes,
// so stdout/stderr are captured through temp files instead.
function run(dir, args, { expectFail = false } = {}) {
  const outFile = path.join(dir, '.out');
  const errFile = path.join(dir, '.err');
  const outFd = fs.openSync(outFile, 'w');
  const errFd = fs.openSync(errFile, 'w');
  const res = spawnSync('node', [CLI, ...args, '--dir', dir], { stdio: ['ignore', outFd, errFd] });
  fs.closeSync(outFd);
  fs.closeSync(errFd);
  const stdout = fs.readFileSync(outFile, 'utf8').trim();
  const stderr = fs.readFileSync(errFile, 'utf8').trim();
  if (!expectFail && res.status !== 0) {
    assert.fail(`command failed (${res.status}): ${args.join(' ')}\n${stderr}`);
  }
  if (expectFail && res.status === 0) assert.fail('command should have failed');
  return { code: res.status, stdout, stderr };
}

function writeJson(dir, name, value) {
  const file = path.join(dir, name);
  fs.writeFileSync(file, JSON.stringify(value));
  return file;
}

test('CLI: full add/derive/revoke/restore/status/verifylog flow', () => {
  const dir = tmpdir();
  const f1 = writeJson(dir, 'f1.json', { id: 'f1', source: 's1', value: 2 });
  const f2 = writeJson(dir, 'f2.json', { id: 'f2', source: 's2', value: 3 });
  const r1 = writeJson(dir, 'r1.json', { id: 'r1', op: 'sum', premises: ['f1', 'f2'], threshold: 4 });

  run(dir, ['add', f1]);
  run(dir, ['add', f2]);
  run(dir, ['derive', r1]);

  let status = JSON.parse(run(dir, ['status', 'r1']).stdout);
  assert.equal(status.state, 'valid');
  assert.equal(status.support, 5);

  run(dir, ['revoke', 's2']);
  status = JSON.parse(run(dir, ['status', 'r1']).stdout);
  assert.equal(status.state, 'degraded');
  assert.equal(status.support, 2);

  run(dir, ['restore', 's2']);
  status = JSON.parse(run(dir, ['status', 'r1']).stdout);
  assert.equal(status.state, 'valid');

  const report = JSON.parse(run(dir, ['verifylog']).stdout);
  assert.equal(report.ok, true);
  assert.equal(report.lastSeq, 5);
});

test('CLI: cycle rejected with E_CYCLE and exit code 1', () => {
  const dir = tmpdir();
  const a = writeJson(dir, 'a.json', { id: 'a', op: 'count', premises: ['b'], threshold: 1 });
  const b = writeJson(dir, 'b.json', { id: 'b', op: 'count', premises: ['a'], threshold: 1 });
  run(dir, ['derive', a]);
  const res = run(dir, ['derive', b], { expectFail: true });
  assert.equal(res.code, 1);
  assert.equal(JSON.parse(res.stderr).error, 'E_CYCLE');
});

test('CLI: revoke of unknown source fails with E_SOURCE_GONE', () => {
  const dir = tmpdir();
  const res = run(dir, ['revoke', 'ghost'], { expectFail: true });
  assert.equal(JSON.parse(res.stderr).error, 'E_SOURCE_GONE');
});

test('CLI: verifylog detects tampering with E_HASH', () => {
  const dir = tmpdir();
  const f1 = writeJson(dir, 'f1.json', { id: 'f1', source: 's1' });
  run(dir, ['add', f1]);
  const wal = path.join(dir, 'wal.log');
  const record = JSON.parse(fs.readFileSync(wal, 'utf8').trim());
  record.payload.source = 'evil';
  fs.writeFileSync(wal, JSON.stringify(record) + '\n');
  const res = run(dir, ['verifylog'], { expectFail: true });
  assert.equal(JSON.parse(res.stderr).error, 'E_HASH');
});

test('CLI: snapshot then verifylog still ok', () => {
  const dir = tmpdir();
  const f1 = writeJson(dir, 'f1.json', { id: 'f1', source: 's1' });
  run(dir, ['add', f1]);
  run(dir, ['snapshot']);
  const f2 = writeJson(dir, 'f2.json', { id: 'f2', source: 's1' });
  run(dir, ['add', f2]);
  const report = JSON.parse(run(dir, ['verifylog']).stdout);
  assert.equal(report.ok, true);
  assert.equal(report.snapshot, true);
  assert.equal(report.lastSeq, 2);
});
