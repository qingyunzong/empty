import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runCli as runCliImport } from '../cli.js';

function runCli(lines) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'refund-cli-'));
  const opsPath = path.join(dir, 'ops.jsonl');
  fs.writeFileSync(opsPath, lines.join('\n') + '\n');
  const res = runCliImport(opsPath, { REFUND_WAL: path.join(dir, 'wal.log') });
  return { status: res.code, stdout: res.stdout, stderr: res.stderr };
}

test('cli: happy path exits 0 and prints report with audit hash', () => {
  const res = runCli([
    '{"type":"payment","order":"o1","amount":1000,"seq":1,"ts":0}',
    '{"type":"refund","key":"k1","order":"o1","amount":100,"riskTag":"low","seq":2,"ts":10}',
    '{"type":"approve","key":"k1","seq":3,"ts":20}',
  ]);
  assert.equal(res.status, 0, res.stderr);
  const report = JSON.parse(res.stdout);
  assert.equal(report.keys.k1.state, 'APPROVED');
  assert.match(report.auditHash, /^[0-9a-f]{64}$/);
  assert.equal(report.responses.length, 3);
});

test('cli: frame error exits 2', () => {
  const res = runCli(['not json']);
  assert.equal(res.status, 2);
  assert.match(res.stderr, /frame error at line 1/);
  const res2 = runCli(['{"type":"bogus","seq":1,"ts":0}']);
  assert.equal(res2.status, 2);
  const res3 = runCli(['{"type":"refund","key":"k1","order":"o1","amount":-5,"riskTag":"low","seq":1,"ts":0}']);
  assert.equal(res3.status, 2);
});

test('cli: conflict exits 3', () => {
  const res = runCli([
    '{"type":"payment","order":"o1","amount":1000,"seq":1,"ts":0}',
    '{"type":"refund","key":"k1","order":"o1","amount":100,"riskTag":"low","seq":2,"ts":0}',
    '{"type":"refund","key":"k1","order":"o1","amount":200,"riskTag":"low","seq":3,"ts":0}',
  ]);
  assert.equal(res.status, 3);
  const report = JSON.parse(res.stdout);
  assert.equal(report.errors[0].type, 'conflict');
});

test('cli: over limit exits 4', () => {
  const res = runCli([
    '{"type":"payment","order":"o1","amount":100,"seq":1,"ts":0}',
    '{"type":"refund","key":"k1","order":"o1","amount":200,"riskTag":"low","seq":2,"ts":0}',
  ]);
  assert.equal(res.status, 4);
  const report = JSON.parse(res.stdout);
  assert.equal(report.keys.k1.code, 'OVER_LIMIT');
});
