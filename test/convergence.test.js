'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { buildPlan } = require('../lib/core');
const { applyPlan } = require('../lib/apply');
const { makeTmp, csvContent, fileName, writeCsv, dirHash, listCsv } = require('./helpers');

const D = '2026-09-15';
const m = (i) => `m${String(i).padStart(3, '0')}`;

function sync(dirA, dirB, tmp) {
  const plan = buildPlan(dirA, dirB);
  return applyPlan(plan, { journalPath: path.join(tmp, `journal-${process.hrtime.bigint()}.json`) });
}

test('验收1: 200 文件含改删, A→B 与 B→A 收敛哈希相同', () => {
  const root = makeTmp();
  const A = path.join(root, 'A');
  const B = path.join(root, 'B');
  fs.mkdirSync(A);
  fs.mkdirSync(B);

  // 140 个基准文件, 先同步一次建立基准状态
  for (let i = 0; i < 140; i++) writeCsv(A, m(i), D, 'CNY', csvContent(`base-${i}`));
  sync(A, B, root);
  assert.strictEqual(dirHash(A), dirHash(B));

  // 制造发散 (键互不重叠): 新增 30+30, 修改 15+15, 删除 5+5 → 共 200 键
  for (let i = 140; i < 170; i++) writeCsv(A, m(i), D, 'CNY', csvContent(`newA-${i}`));
  for (let i = 170; i < 200; i++) writeCsv(B, m(i), D, 'CNY', csvContent(`newB-${i}`));
  for (let i = 0; i < 15; i++) writeCsv(A, m(i), D, 'CNY', csvContent(`modA-${i}`));
  for (let i = 15; i < 30; i++) writeCsv(B, m(i), D, 'CNY', csvContent(`modB-${i}`));
  for (let i = 30; i < 35; i++) fs.unlinkSync(path.join(A, fileName(m(i), D, 'CNY')));
  for (let i = 35; i < 40; i++) fs.unlinkSync(path.join(B, fileName(m(i), D, 'CNY')));

  // 场景1: sync(A,B); 场景2: sync(B,A) 交换参数方向, 各自从相同初始发散出发
  const s1 = makeTmp();
  const s2 = makeTmp();
  const a1 = path.join(s1, 'A');
  const b1 = path.join(s1, 'B');
  const a2 = path.join(s2, 'A');
  const b2 = path.join(s2, 'B');
  fs.cpSync(A, a1, { recursive: true });
  fs.cpSync(B, b1, { recursive: true });
  fs.cpSync(A, a2, { recursive: true });
  fs.cpSync(B, b2, { recursive: true });

  const r1 = sync(a1, b1, s1);
  const r2 = sync(b2, a2, s2);

  const hashes = [dirHash(a1), dirHash(b1), dirHash(a2), dirHash(b2)];
  assert.strictEqual(hashes[0], hashes[1], '场景1 内 A/B 应一致');
  assert.strictEqual(hashes[1], hashes[2], 'A→B 与 B→A 收敛哈希应相同');
  assert.strictEqual(hashes[2], hashes[3], '场景2 内 A/B 应一致');

  assert.strictEqual(listCsv(a1).length, 190, '200 键 - 10 删除 = 190 文件');
  assert.strictEqual(r1.conflicts, 0);
  assert.strictEqual(r2.conflicts, 0);
  assert.strictEqual(r1.copied + r1.deleted, 100, '60 新增 + 30 修改 + 10 删除 = 100 操作');

  // 内容正确性抽查
  assert.strictEqual(fs.readFileSync(path.join(a1, fileName(m(0), D, 'CNY')), 'utf8'), csvContent('modA-0'));
  assert.strictEqual(fs.readFileSync(path.join(b1, fileName(m(15), D, 'CNY')), 'utf8'), csvContent('modB-15'));
  assert.strictEqual(fs.readFileSync(path.join(a1, fileName(m(140), D, 'CNY')), 'utf8'), csvContent('newA-140'));
  assert.strictEqual(fs.readFileSync(path.join(a1, fileName(m(170), D, 'CNY')), 'utf8'), csvContent('newB-170'));
  assert.ok(!fs.existsSync(path.join(a1, fileName(m(30), D, 'CNY'))));
  assert.ok(!fs.existsSync(path.join(b1, fileName(m(35), D, 'CNY'))));

  // 幂等: 再同步一次应无任何操作
  const again = sync(a1, b1, s1);
  assert.strictEqual(again.copied, 0);
  assert.strictEqual(again.deleted, 0);
});
