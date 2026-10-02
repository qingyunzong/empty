'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { run } = require('../src/cli');
const { tmpdir, corruptLayerPayload } = require('./helpers');

// 退出码：0 成功 / 1 业务 / 2 损坏
test('CLI 退出码：0 成功、1 业务、2 损坏', () => {
  const dir = tmpdir();
  let r = run(['init', '--data', dir, '--account', 'alice:1000:1000:1000']);
  assert.equal(r.code, 0, r.stderr);
  r = run(['reserve', '--data', dir, '--tx', 'r1', '--account', 'alice', '--amount', '100']);
  assert.equal(r.code, 0, r.stderr);
  assert.equal(JSON.parse(r.stdout).ok, true);
  // 业务错误：预算不足 -> 1
  r = run(['reserve', '--data', dir, '--tx', 'r2', '--account', 'alice', '--amount', '99999']);
  assert.equal(r.code, 1, `expected 1, got ${r.code}: ${r.stderr}`);
  assert.equal(JSON.parse(r.stderr).ok, false);
  // 业务错误：未知命令/缺参数 -> 1
  r = run(['bogus', '--data', dir]);
  assert.equal(r.code, 1);
  r = run(['reserve', '--data', dir, '--tx', 'r3']);
  assert.equal(r.code, 1);
  r = run(['freeze', '--data', dir, '--tx', 'f1', '--account', 'alice', '--amount', '60', '--parent', 'r1']);
  assert.equal(r.code, 0, r.stderr);
  r = run(['checkpoint', '--data', dir]);
  assert.equal(r.code, 0, r.stderr);
  const cpLayer = JSON.parse(r.stdout).layer;
  r = run(['pay', '--data', dir, '--tx', 'p1', '--account', 'alice', '--amount', '40', '--parent', 'f1']);
  assert.equal(r.code, 0, r.stderr);
  // 损坏检查点之后的中间层（pay 层）
  corruptLayerPayload(dir, cpLayer + 1);
  // 旧检查点仍可恢复 -> 0
  r = run(['restore', '--data', dir, '--checkpoint', String(cpLayer)]);
  assert.equal(r.code, 0, r.stderr);
  const restored = JSON.parse(r.stdout);
  assert.equal(restored.layer, cpLayer);
  assert.equal(restored.state.accounts.alice.credit, 1000 - 60);
  // 跳到损坏层 -> 2
  r = run(['restore', '--data', dir]);
  assert.equal(r.code, 2, `expected 2, got ${r.code}`);
  r = run(['verify', '--data', dir]);
  assert.equal(r.code, 2);
  // 索引损坏 -> 2
  const dir2 = tmpdir();
  run(['init', '--data', dir2, '--account', 'bob:100:100:100']);
  run(['reserve', '--data', dir2, '--tx', 'x1', '--account', 'bob', '--amount', '10']);
  const indexPath = path.join(dir2, 'index.json');
  const index = JSON.parse(fs.readFileSync(indexPath, 'utf8'));
  index.layers['1'].offset += 3;
  fs.writeFileSync(indexPath, JSON.stringify(index, null, 2));
  r = run(['verify', '--data', dir2]);
  assert.equal(r.code, 2, `expected 2, got ${r.code}`);
  r = run(['restore', '--data', dir2]);
  assert.equal(r.code, 2);
});

test('CLI restore 输出孤儿但不并入状态', () => {
  const dir = tmpdir();
  run(['init', '--data', dir, '--account', 'alice:100:100:100']);
  run(['reserve', '--data', dir, '--tx', 'ok1', '--account', 'alice', '--amount', '10']);
  // 模拟崩溃：块已写未链接
  const r = run(['reserve', '--data', dir, '--tx', 'half', '--account', 'alice', '--amount', '5', '--crash', 'after-write']);
  assert.notEqual(r.code, 0);
  const res = run(['restore', '--data', dir]);
  assert.equal(res.code, 0, res.stderr);
  const out = JSON.parse(res.stdout);
  assert.equal(out.layer, 1);
  assert.equal(out.state.txs.half, undefined);
  assert.equal(out.orphans.length, 1);
  assert.deepEqual(out.orphans[0].txs, ['half']);
});
