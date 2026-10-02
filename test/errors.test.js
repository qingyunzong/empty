'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { buildPlan } = require('../lib/core');
const { applyPlan } = require('../lib/apply');
const { makeTmp, csvContent, fileName, writeCsv, runCli } = require('./helpers');

const D = '2026-05-01';

function sync(A, B, root) {
  applyPlan(buildPlan(A, B), { journalPath: path.join(root, `j-${process.hrtime.bigint()}.json`) });
}

test('只读目标 → code=60', () => {
  const root = makeTmp();
  const A = path.join(root, 'A');
  const B = path.join(root, 'B');
  fs.mkdirSync(A);
  fs.mkdirSync(B);
  writeCsv(A, 'm001', D, 'CNY', csvContent('v1'));
  fs.chmodSync(B, 0o555);
  try {
    assert.throws(() => applyPlan(buildPlan(A, B), { journalPath: path.join(root, 'j.json') }), (e) => e.code === 60);
    const r = runCli(['apply', '--a', A, '--b', B, '--journal', path.join(root, 'j2.json')]);
    assert.strictEqual(r.status, 60, `CLI 应以 60 退出: ${r.stderr}`);
    assert.match(r.stderr, /code=60/);
  } finally {
    fs.chmodSync(B, 0o755);
  }
});

test('墓碑复活无新版本 → code=61; 有新版本则正常', () => {
  const root = makeTmp();
  const A = path.join(root, 'A');
  const B = path.join(root, 'B');
  fs.mkdirSync(A);
  fs.mkdirSync(B);
  const F = fileName('m001', D, 'CNY');

  writeCsv(A, 'm001', D, 'CNY', csvContent('v1'));
  sync(A, B, root);
  fs.unlinkSync(path.join(A, F));
  sync(A, B, root); // 删除传播, 两侧写入墓碑
  assert.ok(!fs.existsSync(path.join(B, F)));

  // 以相同内容复活 → 61
  fs.writeFileSync(path.join(A, F), csvContent('v1'));
  assert.throws(() => buildPlan(A, B), (e) => e.code === 61 && /墓碑复活/.test(e.message));
  const r = runCli(['plan', '--a', A, '--b', B]);
  assert.strictEqual(r.status, 61, `CLI 应以 61 退出: ${r.stderr}`);

  // 以新内容复活 → 正常的新版本
  fs.writeFileSync(path.join(A, F), csvContent('v2-新版本'));
  const plan = buildPlan(A, B);
  assert.strictEqual(plan.ops.length, 1);
  assert.strictEqual(plan.ops[0].type, 'copy');
  assert.strictEqual(plan.ops[0].from, 'a');
});
