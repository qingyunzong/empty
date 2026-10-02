import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { run } from '../cli.js';

function runCli(command, logDir) {
  const { exitCode, output } = run([JSON.stringify(command), logDir]);
  return { code: exitCode, body: output };
}

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'saga-cli-'));
}

test('CLI: 正常命令退出码 0 并输出 JSON 结果', () => {
  const dir = tmpDir();
  let r = runCli({ cmd: 'deposit', amount: 500 }, dir);
  assert.equal(r.code, 0);
  assert.deepEqual(r.body.ledger, { available: 500, reserved: 0, feesCollected: 0 });
  r = runCli({ cmd: 'fill', id: 'f1', amount: 100, fee: 5 }, dir);
  assert.equal(r.code, 0);
  assert.equal(r.body.fill.status, 'FILLED');
  r = runCli({ cmd: 'cancel', id: 'f1' }, dir);
  assert.equal(r.code, 0);
  assert.equal(r.body.certificate.status, 'CANCELLED');
  r = runCli({ cmd: 'status' }, dir);
  assert.deepEqual(r.body.snapshot.ledger, { available: 500, reserved: 0, feesCollected: 0 });
  // 日志目录持久化: state.json 与 events.jsonl 已落盘
  assert.ok(fs.existsSync(path.join(dir, 'state.json')));
  assert.ok(fs.existsSync(path.join(dir, 'events.jsonl')));
});

test('CLI: 分支失败退出码 1,状态持久化后重试从未完成分支继续', () => {
  const dir = tmpDir();
  runCli({ cmd: 'deposit', amount: 500 }, dir);
  runCli({ cmd: 'fill', id: 'f1', amount: 100, fee: 5 }, dir);
  let r = runCli({ cmd: 'cancel', id: 'f1', failAt: 'RELEASE_RESERVE' }, dir);
  assert.equal(r.code, 1);
  assert.equal(r.body.error.code, 'COMPENSATION_FAILED');
  assert.equal(r.body.error.details.step, 'RELEASE_RESERVE');
  // 重新加载状态重试: 从 RELEASE_RESERVE 继续,已 ACK 分支不重复退款
  r = runCli({ cmd: 'cancel', id: 'f1' }, dir);
  assert.equal(r.code, 0);
  assert.equal(r.body.certificate.status, 'CANCELLED');
  r = runCli({ cmd: 'status' }, dir);
  assert.deepEqual(r.body.snapshot.ledger, { available: 500, reserved: 0, feesCollected: 0 });
  const acks = JSON.parse(fs.readFileSync(path.join(dir, 'state.json'), 'utf8'))
    .events.filter((e) => e.type === 'COMPENSATION_ACK')
    .map((e) => e.step);
  assert.deepEqual(acks, ['UNDO_MATCH', 'REFUND_FEE', 'RELEASE_RESERVE']);
});

test('CLI: 不可撤销成交返回 IRREVERSIBLE_CONFLICT,退出码 1,余额不变', () => {
  const dir = tmpDir();
  runCli({ cmd: 'deposit', amount: 500 }, dir);
  runCli({ cmd: 'fill', id: 'f1', amount: 100, fee: 5, irreversible: true }, dir);
  const r = runCli({ cmd: 'cancel', id: 'f1' }, dir);
  assert.equal(r.code, 1);
  assert.equal(r.body.error.code, 'IRREVERSIBLE_CONFLICT');
  const s = runCli({ cmd: 'status' }, dir);
  assert.deepEqual(s.body.snapshot.ledger, { available: 395, reserved: 100, feesCollected: 5 });
  assert.equal(s.body.snapshot.fills.f1.status, 'FILLED');
});

test('CLI: 非法命令与用法错误退出码 1 且错误体含 error 代码', () => {
  const dir = tmpDir();
  let r = run(['not-json', dir]);
  assert.equal(r.exitCode, 1);
  assert.equal(r.output.error.code, 'INVALID_COMMAND');
  r = run([]);
  assert.equal(r.exitCode, 1);
  assert.equal(r.output.error.code, 'USAGE');
  r = runCli({ cmd: 'cancel', id: 'ghost' }, dir);
  assert.equal(r.code, 1);
  assert.equal(r.body.error.code, 'FILL_NOT_FOUND');
});
