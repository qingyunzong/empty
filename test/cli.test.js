import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const CLI = fileURLToPath(new URL('../cli.js', import.meta.url));

let captureCounter = 0;

function run(args, cwd) {
  const base = path.join(cwd, `.capture-${process.pid}-${captureCounter++}`);
  const outFd = fs.openSync(base + '.out', 'w');
  const errFd = fs.openSync(base + '.err', 'w');
  const result = spawnSync(process.execPath, [CLI, ...args], {
    cwd,
    stdio: ['ignore', outFd, errFd],
  });
  fs.closeSync(outFd);
  fs.closeSync(errFd);
  return {
    status: result.status,
    stdout: fs.readFileSync(base + '.out', 'utf8'),
    stderr: fs.readFileSync(base + '.err', 'utf8'),
  };
}

test('cli: build log, query slices, output and verify inclusion proof', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'genealogy-cli-'));
  const log = path.join(dir, 'log.jsonl');

  assert.equal(run(['add-batch', 'A', '--note', 'resin lot alpha', '--log', log], dir).status, 0);
  assert.equal(run(['add-batch', 'B', '--note', 'hardener lot beta', '--log', log], dir).status, 0);
  assert.equal(run(['add-batch', 'C', '--note', 'mixed compound', '--log', log], dir).status, 0);
  assert.equal(run(['add-edge', 'C', 'A', '--log', log], dir).status, 0);
  assert.equal(run(['add-edge', 'C', 'B', '--log', log], dir).status, 0);

  const ancestors = JSON.parse(run(['ancestors', 'C', '--log', log], dir).stdout);
  assert.deepEqual(ancestors.results, ['A', 'B']);

  const search = JSON.parse(run(['search', '--phrase', 'resin lot', '--log', log], dir).stdout);
  assert.deepEqual(search.results, ['A']);

  const near = JSON.parse(run(['search', '--near', 'hardener,beta', '--dist', '3', '--log', log], dir).stdout);
  assert.deepEqual(near.results, ['B']);

  const prove = run(['prove', 'A', '--log', log], dir);
  assert.equal(prove.status, 0);
  const proofPath = path.join(dir, 'proof.json');
  fs.writeFileSync(proofPath, prove.stdout);
  const verify = run(['verify-proof', proofPath, '--log', log], dir);
  assert.equal(verify.status, 0);
  assert.equal(JSON.parse(verify.stdout).ok, true);

  const tampered = JSON.parse(prove.stdout);
  tampered.root = 'f'.repeat(64);
  const tamperedPath = path.join(dir, 'tampered.json');
  fs.writeFileSync(tamperedPath, JSON.stringify(tampered));
  const badVerify = run(['verify-proof', tamperedPath, '--log', log], dir);
  assert.equal(badVerify.status, 1);
  assert.match(badVerify.stderr, /E_PROOF/);

  const cycle = run(['add-edge', 'A', 'C', '--log', log], dir);
  assert.equal(cycle.status, 1);
  assert.match(cycle.stderr, /E_CYCLE/);

  const outOfOrder = run(['add-batch', 'D', '--ts', '1', '--log', log], dir);
  assert.equal(outOfOrder.status, 1);
  assert.match(outOfOrder.stderr, /E_TIME/);

  const correct = run(['correct-edge', 'C', 'A', 'B', '--log', log], dir);
  assert.equal(correct.status, 0);
  const record = JSON.parse(correct.stdout).record;
  assert.deepEqual(record.compensation[0], { op: 'revoke', child: 'C', parent: 'A' });

  const oldSlice = JSON.parse(run(['ancestors', 'C', '--at', '5', '--log', log], dir).stdout);
  assert.deepEqual(oldSlice.results, ['A', 'B'], 'old slice unchanged after correction');
  const newSlice = JSON.parse(run(['ancestors', 'C', '--log', log], dir).stdout);
  assert.deepEqual(newSlice.results, ['B']);

  run(['delete-batch', 'B', '--log', log], dir);
  const masked = JSON.parse(run(['descendants', 'B', '--log', log], dir).stdout);
  assert.equal(masked.masked, true);
  const cert = JSON.parse(run(['cert', 'B', '--log', log], dir).stdout);
  assert.equal(cert.tombstone, 1);
});
