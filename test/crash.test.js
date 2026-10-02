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
  return fs.mkdtempSync(path.join(os.tmpdir(), 'audit-crash-'));
}

function runCli(args, env = {}) {
  const ioDir = fs.mkdtempSync(path.join(os.tmpdir(), 'audit-cli-io-'));
  const outPath = path.join(ioDir, 'stdout.txt');
  const errPath = path.join(ioDir, 'stderr.txt');
  const outFd = fs.openSync(outPath, 'w');
  const errFd = fs.openSync(errPath, 'w');
  const result = spawnSync(process.execPath, [CLI, ...args], {
    env: Object.assign({}, process.env, env),
    stdio: ['ignore', outFd, errFd],
  });
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
  store.appendDelta(dir, [{ type: 'add', account: 'cash', amount: 500 }]);
  store.appendDelta(dir, [{ type: 'add', account: 'cash', amount: 250 }]);
  store.writeSnapshot(dir, { accounts: { cash: 750 } });
  store.appendDelta(dir, [{ type: 'add', account: 'cash', amount: 100 }]);
  store.appendDelta(dir, [{ type: 'add', account: 'equity', amount: 60 }]);
  return dir;
}

test('kill before manifest commit -> uncommitted snapshot ignored, previous snapshot used', () => {
  const dir = seedStore(tmpStore());
  const stateFile = path.join(dir, 'next-state.json');
  fs.writeFileSync(stateFile, JSON.stringify({ accounts: { cash: 850, equity: 60 } }));

  const crashed = runCli(['snapshot', '--store', dir, '--state', stateFile, '--crash-point', 'before-commit']);
  assert.strictEqual(crashed.signal, 'SIGKILL', `expected SIGKILL, got ${crashed.signal} ${crashed.stderr}`);

  const snap2 = path.join(dir, 'snapshots', 'snap-000002');
  assert.ok(fs.existsSync(snap2), 'chunk directory may exist after crash');
  assert.ok(!fs.existsSync(path.join(snap2, 'manifest.json')), 'manifest must not be committed');

  const restored = runCli(['restore', '--store', dir]);
  assert.strictEqual(restored.status, 0, restored.stderr);
  const out = JSON.parse(restored.stdout);
  assert.strictEqual(out.trustedPoint.snapshotId, 'snap-000001');
  assert.strictEqual(out.trustedPoint.baseSeq, 2);
  assert.strictEqual(out.appliedThrough, 4);
  assert.deepStrictEqual(out.state.accounts, { cash: 850, equity: 60 });
});

test('kill after manifest commit -> snapshot trusted, restore uses it', () => {
  const dir = seedStore(tmpStore());
  const stateFile = path.join(dir, 'next-state.json');
  fs.writeFileSync(stateFile, JSON.stringify({ accounts: { cash: 850, equity: 60 } }));

  const crashed = runCli(['snapshot', '--store', dir, '--state', stateFile, '--crash-point', 'after-commit']);
  assert.strictEqual(crashed.signal, 'SIGKILL', `expected SIGKILL, got ${crashed.signal} ${crashed.stderr}`);

  const snap2 = path.join(dir, 'snapshots', 'snap-000002');
  assert.ok(fs.existsSync(path.join(snap2, 'manifest.json')), 'manifest must be committed');
  assert.ok(!fs.existsSync(path.join(snap2, 'manifest.json.tmp')), 'no temp manifest may remain');

  const restored = runCli(['restore', '--store', dir]);
  assert.strictEqual(restored.status, 0, restored.stderr);
  const out = JSON.parse(restored.stdout);
  assert.strictEqual(out.trustedPoint.snapshotId, 'snap-000002');
  assert.strictEqual(out.trustedPoint.baseSeq, 4);
  assert.deepStrictEqual(out.state.accounts, { cash: 850, equity: 60 });
});

test('kill before manifest fsync leaves only tmp file -> treated as uncommitted', () => {
  const dir = seedStore(tmpStore());
  const stateFile = path.join(dir, 'next-state.json');
  fs.writeFileSync(stateFile, JSON.stringify({ accounts: { cash: 850, equity: 60 } }));

  const crashed = runCli(['snapshot', '--store', dir, '--state', stateFile, '--crash-point', 'before-manifest-fsync']);
  assert.strictEqual(crashed.signal, 'SIGKILL', `expected SIGKILL, got ${crashed.signal} ${crashed.stderr}`);

  const restored = runCli(['restore', '--store', dir]);
  assert.strictEqual(restored.status, 0, restored.stderr);
  const out = JSON.parse(restored.stdout);
  assert.strictEqual(out.trustedPoint.snapshotId, 'snap-000001');
  assert.deepStrictEqual(out.state.accounts, { cash: 850, equity: 60 });
});
