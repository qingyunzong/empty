import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, openSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const bin = join(dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'recon.js');

// The sandbox swallows piped stdio of spawned children, so capture via files.
function spawnToFiles(args) {
  const dir = mkdtempSync(join(tmpdir(), 'recon-'));
  const outPath = join(dir, 'out.txt');
  const errPath = join(dir, 'err.txt');
  const outFd = openSync(outPath, 'w');
  const errFd = openSync(errPath, 'w');
  const res = spawnSync(process.execPath, args, { stdio: ['ignore', outFd, errFd] });
  return {
    status: res.status,
    stdout: readFileSync(outPath, 'utf8'),
    stderr: readFileSync(errPath, 'utf8'),
    dir,
  };
}

function runCli(input) {
  const dir = mkdtempSync(join(tmpdir(), 'recon-'));
  const file = join(dir, 'recon.json');
  writeFileSync(file, JSON.stringify(input));
  return spawnToFiles([bin, 'minimize', file]);
}

const normal = (entryId, account, amount) => ({ entryId, account, amount, type: 'normal' });
const reversal = (entryId, account, amount, reversalOf) => ({
  entryId,
  account,
  amount,
  type: 'reversal',
  reversalOf,
});

test('minimize prints a certificate with minimal subsets and replay hash', () => {
  const res = runCli({
    expected: [normal('e1', 'cash', 100)],
    actual: [reversal('r1', 'cash', -100, 'e1')],
  });
  assert.equal(res.status, 0, res.stderr);
  const cert = JSON.parse(res.stdout);
  assert.equal(cert.balanced, false);
  assert.equal(cert.algorithm, 'exhaustive-lexmin');
  assert.deepEqual(
    cert.minimal.expected.map((e) => e.entryId),
    ['e1'],
  );
  assert.deepEqual(
    cert.minimal.actual.map((e) => e.entryId),
    ['r1'],
  );
  assert.equal(cert.totalImpact, -200);
  assert.match(cert.replayHash, /^sha256:[0-9a-f]{64}$/);
  assert.equal(cert.diffs.missing.length, 1);
  assert.equal(cert.diffs.invalidReversal.length, 1);
});

test('fully matched input returns a balanced certificate', () => {
  const res = runCli({
    expected: [normal('e1', 'cash', 100), normal('e2', 'ar', 25)],
    actual: [normal('e2', 'ar', 25), normal('e1', 'cash', 100)],
  });
  assert.equal(res.status, 0, res.stderr);
  const cert = JSON.parse(res.stdout);
  assert.equal(cert.balanced, true);
  assert.deepEqual(cert.minimal.expected, []);
  assert.deepEqual(cert.minimal.actual, []);
  assert.equal(cert.totalImpact, 0);
  assert.match(cert.replayHash, /^sha256:/);
});

test('orphan reversal is explicitly classified', () => {
  const res = runCli({ expected: [], actual: [reversal('r9', 'cash', -40, 'ghost')] });
  assert.equal(res.status, 0, res.stderr);
  const cert = JSON.parse(res.stdout);
  assert.equal(cert.diffs.invalidReversal.length, 1);
  assert.equal(cert.diffs.invalidReversal[0].entry.entryId, 'r9');
  assert.match(cert.diffs.invalidReversal[0].reason, /not found/);
});

test('duplicate id is rejected with exit code 1 and INVALID_RECON', () => {
  const res = runCli({
    expected: [normal('e1', 'cash', 1), normal('e1', 'cash', 2)],
    actual: [],
  });
  assert.equal(res.status, 1);
  assert.match(res.stderr, /INVALID_RECON/);
  assert.match(res.stderr, /duplicate entryId/);
});

test('negative amount is rejected with exit code 1 and INVALID_RECON', () => {
  const res = runCli({ expected: [normal('e1', 'cash', -5)], actual: [] });
  assert.equal(res.status, 1);
  assert.match(res.stderr, /INVALID_RECON/);
  assert.match(res.stderr, /negative amount/);
});

test('reversal chain is rejected with exit code 1 and INVALID_RECON', () => {
  const res = runCli({
    expected: [
      normal('e1', 'cash', 100),
      reversal('r1', 'cash', -100, 'e1'),
      reversal('r2', 'cash', 100, 'r1'),
    ],
    actual: [],
  });
  assert.equal(res.status, 1);
  assert.match(res.stderr, /INVALID_RECON/);
  assert.match(res.stderr, /reversal chain/);
});

test('malformed JSON file is rejected with exit code 1 and INVALID_RECON', () => {
  const dir = mkdtempSync(join(tmpdir(), 'recon-'));
  const file = join(dir, 'recon.json');
  writeFileSync(file, '{not json');
  const res = spawnToFiles([bin, 'minimize', file]);
  assert.equal(res.status, 1);
  assert.match(res.stderr, /INVALID_RECON/);
});
