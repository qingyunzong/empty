'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { makeTmp, writeCsv, fileName, runCli } = require('./helpers');

const D = '2026-03-01';
const CHUNK = 256;

function runApply(args, env = {}) {
  return runCli(['apply', ...args], { env });
}

test('验收3: 复制到一半 kill, resume 不重复已确认块', () => {
  const root = makeTmp();
  const A = path.join(root, 'A');
  const B = path.join(root, 'B');
  fs.mkdirSync(A);
  fs.mkdirSync(B);

  // file1 = 3 块, file2 = 20 块 (键序 m100 < m200, 按序执行)
  const c1 = 'a'.repeat(CHUNK * 3);
  const c2 = 'b'.repeat(CHUNK * 20);
  writeCsv(A, 'm100', D, 'CNY', c1);
  writeCsv(A, 'm200', D, 'CNY', c2);

  const planPath = path.join(root, 'plan.json');
  const journalPath = path.join(root, 'journal.json');
  const planRes = runCli(['plan', '--a', A, '--b', B, '--out', planPath]);
  assert.strictEqual(planRes.status, 0, planRes.stderr);
  const plan = JSON.parse(fs.readFileSync(planPath, 'utf8'));
  assert.strictEqual(plan.stats.copies, 2);

  // 第 8 块确认后模拟 kill (file1 完成 3 块 + file2 完成 5 块)
  const r1 = runApply(['--plan', planPath, '--journal', journalPath, '--chunk-size', String(CHUNK)], {
    SYNC_KILL_AFTER_CHUNKS: '8',
  });
  assert.strictEqual(r1.status, 75, `应被模拟 kill, 实际: ${r1.status} ${r1.stderr}`);

  const journal1 = JSON.parse(fs.readFileSync(journalPath, 'utf8'));
  const op1 = plan.ops.find((o) => o.key.startsWith('m100'));
  const op2 = plan.ops.find((o) => o.key.startsWith('m200'));
  assert.strictEqual(journal1.ops[op1.id].status, 'done');
  assert.strictEqual(journal1.ops[op2.id].status, 'in-progress');
  assert.strictEqual(journal1.ops[op2.id].confirmedBytes, CHUNK * 5);
  assert.strictEqual(journal1.ops[op2.id].chunksConfirmed, 5);

  // resume: 只应补 file2 的第 5..19 块, 不重复已确认块
  const r2 = runApply(['--plan', planPath, '--journal', journalPath, '--chunk-size', String(CHUNK)], {
    SYNC_TRACE: '1',
  });
  assert.strictEqual(r2.status, 0, r2.stderr);
  const lines = r2.stderr.trim().split('\n').filter((l) => l.startsWith('CHUNK'));
  assert.strictEqual(lines.length, 15, '只补剩余 15 块');
  const idxs = lines.map((l) => Number(/idx=(\d+)/.exec(l)[1]));
  assert.strictEqual(Math.min(...idxs), 5, '首块从 idx=5 续传, 不重传 0..4');
  assert.deepStrictEqual([...idxs].sort((x, y) => x - y), Array.from({ length: 15 }, (_, i) => i + 5));
  assert.ok(lines.every((l) => l.includes(`op=${op2.id.slice(0, 12)}`)), 'file1 不重传');

  assert.strictEqual(fs.readFileSync(path.join(B, fileName('m100', D, 'CNY')), 'utf8'), c1);
  assert.strictEqual(fs.readFileSync(path.join(B, fileName('m200', D, 'CNY')), 'utf8'), c2);
  const journal2 = JSON.parse(fs.readFileSync(journalPath, 'utf8'));
  assert.strictEqual(journal2.ops[op1.id].status, 'done');
  assert.strictEqual(journal2.ops[op2.id].status, 'done');

  // 幂等: 第三次执行全部跳过
  const r3 = runApply(['--plan', planPath, '--journal', journalPath, '--chunk-size', String(CHUNK)]);
  assert.strictEqual(r3.status, 0, r3.stderr);
  const summary3 = JSON.parse(r3.stdout);
  assert.strictEqual(summary3.copied, 0);
  assert.strictEqual(summary3.skipped, 2);
});
