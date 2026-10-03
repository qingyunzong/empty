import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  HASH_A, HASH_B, readCases, tmpDir, writeInput,
} from './helpers.js';

const BIN = fileURLToPath(new URL('../bin/pack.js', import.meta.url));

// The sandboxed runner cannot capture child pipes, so stderr/stdout go to files.
function runCli(args, root) {
  fs.mkdirSync(root, { recursive: true });
  const stdoutFile = path.join(root, 'stdout.txt');
  const stderrFile = path.join(root, 'stderr.txt');
  const outFd = fs.openSync(stdoutFile, 'w');
  const errFd = fs.openSync(stderrFile, 'w');
  let status;
  try {
    status = spawnSync(process.execPath, [BIN, ...args], { stdio: ['ignore', outFd, errFd] }).status;
  } finally {
    fs.closeSync(outFd);
    fs.closeSync(errFd);
  }
  return { status, stdout: fs.readFileSync(stdoutFile, 'utf8'), stderr: fs.readFileSync(stderrFile, 'utf8') };
}

function makeInput(dir) {
  return writeInput(dir, {
    'barcode.jsonl': [
      { eventTs: 1000, frame: 1, case: 'C1', op: 'b1' },
      { eventTs: 1100, frame: 2, case: 'C2', op: 'b2' },
    ],
    'vision.jsonl': [
      { eventTs: 2000, frame: 1, sku: 'S1', defect: null, hash: HASH_A, op: 'v1' },
      { eventTs: 2100, frame: 2, sku: 'S2', defect: 'dent', hash: HASH_B, op: 'v2' },
    ],
    'audit.jsonl': [
      { eventTs: 3000, sku: 'S1', pass: true, op: 'a1' },
    ],
  });
}

test('CLI pack quarantine writes cases.jsonl, release.json, wal.jsonl and late.log', () => {
  const root = tmpDir();
  const inDir = makeInput(path.join(root, 'in'));
  const outDir = path.join(root, 'out');
  const res = runCli(['quarantine', '--in', inDir, '--out', outDir], path.join(root, 'run1'));
  assert.equal(res.status, 0, res.stderr);
  for (const f of ['cases.jsonl', 'release.json', 'wal.jsonl', 'late.log']) {
    assert.ok(fs.existsSync(path.join(outDir, f)), `${f} exists`);
  }
  const cases = readCases(outDir);
  assert.equal(cases.find((c) => c.case === 'C1').state, 'RELEASE');
  assert.equal(cases.find((c) => c.case === 'C2').state, 'QUAR');
  const release = JSON.parse(fs.readFileSync(path.join(outDir, 'release.json'), 'utf8'));
  assert.deepEqual(release.released, ['C1']);
  assert.equal(release.watermark, 3000 - 3000);
  // wal holds every applied event and replaying the run is idempotent.
  const walLines = fs.readFileSync(path.join(outDir, 'wal.jsonl'), 'utf8').trim().split('\n');
  assert.equal(walLines.length, 5);
  const res2 = runCli(['quarantine', '--in', inDir, '--out', outDir], path.join(root, 'run2'));
  assert.equal(res2.status, 0, res2.stderr);
  assert.equal(fs.readFileSync(path.join(outDir, 'wal.jsonl'), 'utf8').trim().split('\n').length, 5);
});

test('CLI reports HASH_BAD and exits non-zero', () => {
  const root = tmpDir();
  const inDir = writeInput(path.join(root, 'in'), {
    'vision.jsonl': [{ eventTs: 1000, frame: 1, sku: 'S1', defect: 'dent', hash: 'XYZ', op: 'v1' }],
  });
  const res = runCli(['quarantine', '--in', inDir, '--out', path.join(root, 'out')], path.join(root, 'run'));
  assert.equal(res.status, 1);
  assert.match(res.stderr, /HASH_BAD/);
});

test('CLI rejects missing arguments with usage', () => {
  const res = runCli(['quarantine'], tmpDir());
  assert.equal(res.status, 64);
  assert.match(res.stderr, /usage: pack quarantine/);
});
