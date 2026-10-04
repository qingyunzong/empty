import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { solve } from '../src/solver.js';
import { buildCertificate, verifyCertificate } from '../src/verify.js';
import { demoSpec, oldLayout } from '../src/instance.js';
import { checkLayout } from '../src/constraints.js';

function demoCert() {
  const spec = demoSpec();
  return buildCertificate(spec, solve(spec));
}

test('最优证书通过独立校验', () => {
  const cert = demoCert();
  const v = verifyCertificate(cert);
  assert.deepEqual(v.problems, []);
  assert.ok(v.ok);
  assert.equal(cert.status, 'optimal');
  assert.equal(cert.lowerBound, cert.upperBound);
  assert.ok(cert.checks.length > 0);
  assert.ok(cert.checks.every((c) => c.satisfied));
});

test('预算未闭合证书: bounded 状态保留上下界且可校验', () => {
  const spec = demoSpec();
  const cert = buildCertificate(spec, solve(spec, { nodeBudget: 1 }));
  assert.equal(cert.status, 'bounded');
  assert.ok(cert.lowerBound! < cert.upperBound!);
  assert.ok(verifyCertificate(cert).ok);
});

test('篡改布局坐标 → 校验失败', () => {
  const cert = demoCert();
  cert.layout![0]!.x += 1;
  assert.ok(!verifyCertificate(cert).ok);
});

test('篡改目标值 → 校验失败', () => {
  const cert = demoCert();
  cert.objective = 99;
  assert.ok(!verifyCertificate(cert).ok);
});

test('篡改 specHash → 校验失败', () => {
  const cert = demoCert();
  cert.specHash = 'deadbeef';
  assert.ok(!verifyCertificate(cert).ok);
});

test('篡改下界使 optimal 不闭合 → 校验失败', () => {
  const cert = demoCert();
  cert.lowerBound = 0;
  assert.ok(!verifyCertificate(cert).ok);
});

test('把违反约束的旧布局伪造成解 → 校验失败', () => {
  const spec = demoSpec();
  const forged = buildCertificate(spec, {
    status: 'optimal',
    layout: oldLayout(spec),
    objective: 0,
    lowerBound: 0,
    upperBound: 0,
    nodesExplored: 0,
  });
  const v = verifyCertificate(forged);
  assert.ok(!v.ok);
  assert.ok(v.problems.some((p) => p.includes('未满足约束')));
  // 旧布局确实违反 3 条对齐约束
  assert.equal(checkLayout(spec, oldLayout(spec)).filter((c) => !c.satisfied).length, 3);
});
