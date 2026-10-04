'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { chainFrames, encodeFrame } = require('./helpers');

const CLI = path.join(__dirname, '..', 'cli.js');
const EXIT_CRASH = 70;

function tmpdir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'at-recovery-'));
}

let outCounter = 0;
// This sandbox does not deliver grandchild stdout over pipes, so the child's
// stdout is redirected to a file and read back.
function runCli(dir, extraEnv = {}) {
  const outPath = path.join(dir, '.stdout-' + ++outCounter);
  const errPath = path.join(dir, '.stderr-' + outCounter);
  const fd = fs.openSync(outPath, 'w');
  const efd = fs.openSync(errPath, 'w');
  const proc = spawnSync(process.execPath, [CLI, path.join(dir, 'frames.bin')], {
    env: { ...process.env, AT_DIR: dir, ...extraEnv },
    stdio: ['ignore', fd, efd],
    encoding: 'utf8',
  });
  fs.closeSync(fd);
  fs.closeSync(efd);
  proc.stdout = fs.readFileSync(outPath, 'utf8');
  proc.stderr = fs.readFileSync(errPath, 'utf8');
  return proc;
}

function runCliVerify(dir) {
  const outPath = path.join(dir, '.stdout-v' + ++outCounter);
  const errPath = path.join(dir, '.stderr-v' + outCounter);
  const fd = fs.openSync(outPath, 'w');
  const efd = fs.openSync(errPath, 'w');
  const proc = spawnSync(process.execPath, [CLI, 'verify', path.join(dir, 'checkpoint.json')], {
    stdio: ['ignore', fd, efd],
    encoding: 'utf8',
  });
  fs.closeSync(fd);
  fs.closeSync(efd);
  proc.stdout = fs.readFileSync(outPath, 'utf8');
  proc.stderr = fs.readFileSync(errPath, 'utf8');
  return proc;
}

function summaryOf(proc) {
  const lines = proc.stdout.trim().split('\n');
  return JSON.parse(lines[lines.length - 1]);
}

const frames = chainFrames([
  { args: { key: 'a', value: 1 } },
  { args: { key: 'b', value: 2 } },
  { args: { key: 'c', value: 3 } },
  { args: { key: 'd', value: 4 } },
  { args: { key: 'e', value: 5 } },
  { args: { key: 'f', value: 6 } },
]);
const blob = Buffer.concat(frames.map(encodeFrame));

function freshDir() {
  const dir = tmpdir();
  fs.writeFileSync(path.join(dir, 'frames.bin'), blob);
  return dir;
}

test('acceptance 4: recovery from all three crash points reproduces the reference run', () => {
  const refDir = freshDir();
  const ref = runCli(refDir);
  assert.equal(ref.status, 0, ref.stderr);
  const refSummary = summaryOf(ref);
  assert.equal(refSummary.count, 6);

  for (const point of ['parse', 'flush', 'index']) {
    for (const crashAt of [2, 5]) {
      const dir = freshDir();
      const crashed = runCli(dir, { AT_CRASH_AFTER: point, AT_CRASH_AT: String(crashAt) });
      assert.equal(crashed.status, EXIT_CRASH, `${point}@${crashAt}: ${crashed.stderr}`);
      const recovered = runCli(dir);
      assert.equal(recovered.status, 0, `${point}@${crashAt}: ${recovered.stderr}`);
      const summary = summaryOf(recovered);
      assert.equal(summary.count, 6, `${point}@${crashAt}`);
      assert.equal(summary.root, refSummary.root, `${point}@${crashAt}: root matches reference`);
      assert.equal(summary.headHash, refSummary.headHash, `${point}@${crashAt}: head matches reference`);
      // Recovered log verifies against its checkpoint.
      const verify = runCliVerify(dir);
      assert.equal(verify.status, 0, `${point}@${crashAt}: ${verify.stdout}`);
      assert.equal(JSON.parse(verify.stdout).ok, true);
    }
  }
});

test('rebuilt index is consistent with the log after crash before index update', () => {
  const dir = freshDir();
  const crashed = runCli(dir, { AT_CRASH_AFTER: 'flush', AT_CRASH_AT: '3' });
  assert.equal(crashed.status, EXIT_CRASH);
  // Log has 3 entries; index was persisted only up to entry 2.
  const logLines = fs.readFileSync(path.join(dir, 'audit.log'), 'utf8').trim().split('\n');
  assert.equal(logLines.length, 3);
  const idx = JSON.parse(fs.readFileSync(path.join(dir, 'audit.index.json'), 'utf8'));
  assert.equal(idx.count, 2);
  const recovered = runCli(dir);
  assert.equal(recovered.status, 0);
  const idx2 = JSON.parse(fs.readFileSync(path.join(dir, 'audit.index.json'), 'utf8'));
  assert.equal(idx2.count, 6);
  assert.equal(idx2.headHash, summaryOf(recovered).headHash);
});
