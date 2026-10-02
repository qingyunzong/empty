'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { buildPlan } = require('../lib/core');
const { applyPlan } = require('../lib/apply');
const { resolveConflicts } = require('../lib/resolve');
const { makeTmp, csvContent, fileName, writeCsv, dirHash, sha256 } = require('./helpers');

const D = '2026-01-01';
const M = 'm001';
const F = fileName(M, D, 'CNY');
const BASE = F.replace(/\.csv$/, '');

function setupConflict() {
  const root = makeTmp();
  const A = path.join(root, 'A');
  const B = path.join(root, 'B');
  fs.mkdirSync(A);
  fs.mkdirSync(B);
  writeCsv(A, M, D, 'CNY', csvContent('v0'));
  const plan0 = buildPlan(A, B);
  applyPlan(plan0, { journalPath: path.join(root, 'j0.json') });
  const contentX = csvContent('X-修改自A', 7);
  const contentY = csvContent('Y-修改自B', 9);
  fs.writeFileSync(path.join(A, F), contentX);
  fs.writeFileSync(path.join(B, F), contentY);
  return { root, A, B, contentX, contentY };
}

test('验收2: 同键冲突生成同一 conflict 证书, 内容保持双份', () => {
  const { root, A, B, contentX, contentY } = setupConflict();

  // 同一冲突, 两个方向生成相同证书
  const planAB = buildPlan(A, B);
  const planBA = buildPlan(B, A);
  const cAB = planAB.ops.find((o) => o.type === 'conflict');
  const cBA = planBA.ops.find((o) => o.type === 'conflict');
  assert.ok(cAB && cBA, '两个方向都应识别为冲突');
  assert.strictEqual(cAB.kind, 'both-modified');
  assert.strictEqual(cAB.certificate.certId, cBA.certificate.certId, 'certId 与目录顺序无关');
  assert.match(cAB.certificate.explanation, /各自做了不同修改/);

  // apply 禁止静默取胜: 冲突键不动, 双方内容原样保留
  const summary = applyPlan(planAB, { journalPath: path.join(root, 'j1.json') });
  assert.strictEqual(summary.conflicts, 1);
  assert.strictEqual(fs.readFileSync(path.join(A, F), 'utf8'), contentX);
  assert.strictEqual(fs.readFileSync(path.join(B, F), 'utf8'), contentY);

  // resolve keep-both: 双份内容保留在两侧, 证书文件逐字节相同
  const r = resolveConflicts(A, B, { strategy: 'keep-both' });
  assert.strictEqual(r.resolved, 1);
  const certA = fs.readFileSync(path.join(A, `${BASE}.conflict.json`), 'utf8');
  const certB = fs.readFileSync(path.join(B, `${BASE}.conflict.json`), 'utf8');
  assert.strictEqual(certA, certB, '两侧证书文件逐字节相同');
  assert.strictEqual(JSON.parse(certA).certId, cAB.certificate.certId);

  const hx = sha256(contentX).slice(0, 8);
  const hy = sha256(contentY).slice(0, 8);
  for (const dir of [A, B]) {
    assert.strictEqual(fs.readFileSync(path.join(dir, `${BASE}.${hx}.csv`), 'utf8'), contentX);
    assert.strictEqual(fs.readFileSync(path.join(dir, `${BASE}.${hy}.csv`), 'utf8'), contentY);
    assert.ok(!fs.existsSync(path.join(dir, F)), '原键已墓碑化');
  }
  assert.strictEqual(dirHash(A), dirHash(B), 'resolve 后两目录收敛');

  // 再次 diff: 无冲突无操作
  const plan2 = buildPlan(A, B);
  assert.strictEqual(plan2.ops.length, 0);
});

test('冲突 resolve 策略 b: 指定侧胜出, 败方内容仍保留', () => {
  const { A, B, contentX, contentY } = setupConflict();
  const r = resolveConflicts(A, B, { strategy: 'b' });
  assert.strictEqual(r.resolved, 1);
  for (const dir of [A, B]) {
    assert.strictEqual(fs.readFileSync(path.join(dir, F), 'utf8'), contentY, 'B 侧内容胜出');
    const hx = sha256(contentX).slice(0, 8);
    assert.strictEqual(fs.readFileSync(path.join(dir, `${BASE}.${hx}.csv`), 'utf8'), contentX, '败方内容保留');
  }
  assert.strictEqual(dirHash(A), dirHash(B));
  const plan2 = buildPlan(A, B);
  assert.strictEqual(plan2.ops.length, 0, 'resolve 后无残留操作');
});
