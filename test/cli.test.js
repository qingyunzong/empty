import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { closeSync, mkdtempSync, openSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const BIN = fileURLToPath(new URL('../bin/tx.js', import.meta.url));

function setup(state) {
  const dir = mkdtempSync(join(tmpdir(), 'tx-cli-'));
  writeFileSync(join(dir, 'state.json'), JSON.stringify(state));
  return dir;
}

let captureSeq = 0;

// The sandbox cannot capture piped stdout/stderr from spawnSync, so the
// child's streams are redirected to files and read back.
function run(dir, args) {
  captureSeq += 1;
  const outPath = join(dir, `cap-${captureSeq}.out`);
  const errPath = join(dir, `cap-${captureSeq}.err`);
  const outFd = openSync(outPath, 'w');
  const errFd = openSync(errPath, 'w');
  const res = spawnSync(process.execPath, [BIN, ...args], {
    cwd: dir,
    stdio: ['ignore', outFd, errFd],
  });
  closeSync(outFd);
  closeSync(errFd);
  return {
    status: res.status,
    stdout: readFileSync(outPath, 'utf8'),
    stderr: readFileSync(errPath, 'utf8'),
  };
}

function apply(dir, cmd, statePath) {
  const cmdPath = join(dir, `cmd-${Math.random().toString(36).slice(2)}.json`);
  writeFileSync(cmdPath, JSON.stringify(cmd));
  const args = ['apply', cmdPath];
  if (statePath) args.push('--state', statePath);
  return run(dir, args);
}

const seed = () => ({
  version: 1,
  accounts: { alice: { available: 100, frozen: 0, locked: 0 } },
  transactions: {},
  migrations: [],
  processed: {},
  seq: 0,
});

function readState(dir) {
  return JSON.parse(readFileSync(join(dir, 'state.json'), 'utf8'));
}

test('CLI: apply 成功 exit0 并持久化状态', () => {
  const dir = setup(seed());
  const res = apply(dir, { type: 'transfer', id: 't1', from: 'alice', to: 'bob', amount: 40 });
  assert.equal(res.status, 0, res.stderr);
  const report = JSON.parse(res.stdout);
  assert.equal(report.ok, true);
  assert.equal(report.result.status, 'POSTED');
  const state = readState(dir);
  assert.equal(state.accounts.alice.available, 60);
  assert.equal(state.accounts.bob.available, 40);
  assert.equal(state.migrations.length, 1);
});

test('CLI: 非法迁移 exit15，金额越界 exit16，未知命令 exit17', () => {
  const dir = setup(seed());
  assert.equal(apply(dir, { type: 'reverse', tx: 'nope' }).status, 15);
  assert.equal(apply(dir, { type: 'transfer', id: 't1', from: 'alice', to: 'bob', amount: 0 }).status, 16);
  assert.equal(apply(dir, { type: 'transfer', id: 't1', from: 'alice', to: 'bob', amount: 999 }).status, 16);
  assert.equal(apply(dir, { type: 'teleport' }).status, 17);
  const state = readState(dir);
  assert.equal(state.accounts.alice.available, 100);
  assert.equal(state.migrations.length, 0);
});

test('CLI: 终态 RESTORED 再 reverse  exit15', () => {
  const dir = setup(seed());
  assert.equal(apply(dir, { type: 'transfer', id: 't1', from: 'alice', to: 'bob', amount: 100 }).status, 0);
  assert.equal(apply(dir, { type: 'reverse', tx: 't1' }).status, 0);
  assert.equal(apply(dir, { type: 'reverseReversal', tx: 't1' }).status, 0);
  assert.equal(apply(dir, { type: 'reverse', tx: 't1' }).status, 15);
  assert.equal(apply(dir, { type: 'reverseReversal', tx: 't1' }).status, 15);
});

test('CLI: 幂等重放返回原结果，资金只动一次', () => {
  const dir = setup(seed());
  const cmd = { type: 'transfer', id: 't1', from: 'alice', to: 'bob', amount: 30, idempotencyKey: 'K1' };
  const first = apply(dir, cmd);
  const second = apply(dir, cmd);
  assert.equal(first.status, 0);
  assert.equal(second.status, 0);
  assert.equal(JSON.parse(second.stdout).replayed, true);
  assert.deepEqual(JSON.parse(second.stdout).result, JSON.parse(first.stdout).result);
  const state = readState(dir);
  assert.equal(state.accounts.bob.available, 30);
  assert.equal(state.migrations.length, 1);
});

test('CLI: --state 指定路径，verify 校验哈希链与不变量', () => {
  const dir = setup(seed());
  const custom = join(dir, 'custom-state.json');
  writeFileSync(custom, JSON.stringify(seed()));
  const res = apply(dir, { type: 'freeze', account: 'alice', amount: 20 }, custom);
  assert.equal(res.status, 0, res.stderr);
  const saved = JSON.parse(readFileSync(custom, 'utf8'));
  assert.deepEqual(saved.accounts.alice, { available: 80, frozen: 20, locked: 0 });
  const verify = run(dir, ['verify', '--state', custom]);
  assert.equal(verify.status, 0, verify.stderr);
  assert.equal(JSON.parse(verify.stdout).ok, true);
});

test('CLI: 缺参数/坏文件 exit1', () => {
  const dir = setup(seed());
  assert.equal(run(dir, ['apply']).status, 1);
  assert.equal(run(dir, ['apply', join(dir, 'missing.json')]).status, 1);
  assert.equal(run(dir, ['bogus']).status, 1);
});
