'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const store = require('../lib/store');

const CLI = path.join(__dirname, '..', 'cli.js');

function tmpStore() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'audit-check-'));
}

function runCli(args) {
  const ioDir = fs.mkdtempSync(path.join(os.tmpdir(), 'audit-cli-io-'));
  const outPath = path.join(ioDir, 'stdout.txt');
  const errPath = path.join(ioDir, 'stderr.txt');
  const outFd = fs.openSync(outPath, 'w');
  const errFd = fs.openSync(errPath, 'w');
  const result = spawnSync(process.execPath, [CLI, ...args], { stdio: ['ignore', outFd, errFd] });
  fs.closeSync(outFd);
  fs.closeSync(errFd);
  return {
    status: result.status,
    signal: result.signal,
    stdout: fs.readFileSync(outPath, 'utf8'),
    stderr: fs.readFileSync(errPath, 'utf8'),
  };
}

function seedStore(dir) {
  const accounts = { cash: 0, equity: 0 };
  for (let i = 0; i < 30; i += 1) {
    const account = i % 2 === 0 ? 'cash' : 'equity';
    const amount = (i * 11) % 17;
    store.appendDelta(dir, [{ type: 'add', account, amount }]);
    accounts[account] += amount;
    if (i % 10 === 9) store.writeSnapshot(dir, { accounts: Object.assign({}, accounts) }, { chunkSize: 32 });
  }
  return accounts;
}

test('check emits a coverage proof that an independent command verifies', () => {
  const dir = tmpStore();
  const accounts = seedStore(dir);
  const proofPath = path.join(dir, 'proof.json');

  const check = runCli(['check', '--store', dir, '--proof', proofPath]);
  assert.strictEqual(check.status, 0, check.stderr);
  assert.ok(fs.existsSync(proofPath));

  const proof = JSON.parse(fs.readFileSync(proofPath, 'utf8'));
  assert.strictEqual(proof.snapshots.filter((s) => s.committed).length, 3);
  assert.strictEqual(proof.delta.count, 30);
  assert.strictEqual(proof.delta.contiguous, true);
  assert.strictEqual(proof.trustedPoint.snapshotId, 'snap-000003');
  assert.strictEqual(proof.trustedPoint.baseSeq, 30);
  assert.strictEqual(typeof proof.proofHash, 'string');

  const expectedStateHash = store.sha256(store.serializeState({ accounts }));
  assert.strictEqual(proof.recovered.finalStateHash, expectedStateHash);

  const verify = runCli(['check', '--store', dir, '--verify', proofPath]);
  assert.strictEqual(verify.status, 0, verify.stderr);
  assert.strictEqual(JSON.parse(verify.stdout).verified, true);
});

test('independent verification rejects a tampered proof and a mutated store', () => {
  const dir = tmpStore();
  seedStore(dir);
  const proofPath = path.join(dir, 'proof.json');
  assert.strictEqual(runCli(['check', '--store', dir, '--proof', proofPath]).status, 0);

  const tamperedPath = path.join(dir, 'proof-tampered.json');
  const tampered = JSON.parse(fs.readFileSync(proofPath, 'utf8'));
  tampered.delta.count = 29;
  fs.writeFileSync(tamperedPath, JSON.stringify(tampered, null, 2));
  const rejectTampered = runCli(['check', '--store', dir, '--verify', tamperedPath]);
  assert.strictEqual(rejectTampered.status, 1);
  assert.strictEqual(JSON.parse(rejectTampered.stdout).verified, false);

  store.appendDelta(dir, [{ type: 'add', account: 'cash', amount: 1 }]);
  const rejectMutated = runCli(['check', '--store', dir, '--verify', proofPath]);
  assert.strictEqual(rejectMutated.status, 1);
  assert.strictEqual(JSON.parse(rejectMutated.stdout).verified, false);
});

test('check exits with code 50 on missing chunk and 51 on seq hole', () => {
  const dir = tmpStore();
  seedStore(dir);

  const snap3Chunks = path.join(dir, 'snapshots', 'snap-000003', 'chunks');
  fs.unlinkSync(path.join(snap3Chunks, fs.readdirSync(snap3Chunks).sort()[0]));
  const missing = runCli(['check', '--store', dir]);
  assert.strictEqual(missing.status, 50, missing.stderr);
  assert.strictEqual(JSON.parse(missing.stderr).code, 50);

  const dir2 = tmpStore();
  seedStore(dir2);
  fs.appendFileSync(path.join(dir2, 'delta.log'), store.canonical({ seq: 99, ops: [{ type: 'add', account: 'cash', amount: 1 }] }) + '\n');
  const hole = runCli(['check', '--store', dir2]);
  assert.strictEqual(hole.status, 51, hole.stderr);
  assert.strictEqual(JSON.parse(hole.stderr).code, 51);
});
