import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { solve } from '../src/solver.js';
import { allSatisfied, checkLayout } from '../src/constraints.js';
import { demoSpec } from '../src/instance.js';
import type { LayoutSpec } from '../src/model.js';

test('演示实例: 最优总移动距离 4，下界闭合', () => {
  const spec = demoSpec();
  const r = solve(spec);
  assert.equal(r.status, 'optimal');
  assert.equal(r.objective, 4);
  assert.equal(r.lowerBound, 4);
  assert.equal(r.upperBound, 4);
  assert.ok(r.layout);
  assert.ok(allSatisfied(checkLayout(spec, r.layout!)));
});

test('预算耗尽: 保留上下界且不闭合', () => {
  const spec = demoSpec();
  const r = solve(spec, { nodeBudget: 1 });
  assert.equal(r.status, 'bounded');
  assert.equal(r.upperBound, 4); // 贪心种子已找到可行解
  assert.ok(r.lowerBound !== null && r.lowerBound >= 3 && r.lowerBound < 4, `lb=${r.lowerBound}`);
  assert.ok(r.lowerBound! <= r.upperBound!);
});

test('不可行实例: 两个 2x2 矩形放不进 2x2 网格', () => {
  const spec: LayoutSpec = {
    grid: 2,
    rects: [
      { id: 'a', minW: 2, maxW: 2, minH: 2, maxH: 2, oldX: 0, oldY: 0, oldW: 2, oldH: 2 },
      { id: 'b', minW: 2, maxW: 2, minH: 2, maxH: 2, oldX: 0, oldY: 0, oldW: 2, oldH: 2 },
    ],
    align: [],
  };
  const r = solve(spec);
  assert.equal(r.status, 'infeasible');
  assert.equal(r.layout, null);
  assert.equal(r.objective, null);
});

test('旧布局已可行: 最优为 0（不移动）', () => {
  const spec: LayoutSpec = {
    grid: 6,
    rects: [
      { id: 'a', minW: 1, maxW: 2, minH: 1, maxH: 2, oldX: 0, oldY: 0, oldW: 1, oldH: 1 },
      { id: 'b', minW: 1, maxW: 2, minH: 1, maxH: 2, oldX: 3, oldY: 3, oldW: 2, oldH: 2 },
    ],
    align: [{ a: 'a', b: 'b', edge: 'top' }],
  };
  // top 对齐不满足（0 != 3），需要移动；先验证不是 0
  const r = solve(spec);
  assert.ok(r.objective! > 0);
  const spec2: LayoutSpec = { ...spec, align: [] };
  const r2 = solve(spec2);
  assert.equal(r2.status, 'optimal');
  assert.equal(r2.objective, 0);
});

test('对齐奇偶性: 中心对齐在奇偶不可达时不可行', () => {
  const spec: LayoutSpec = {
    grid: 6,
    rects: [
      { id: 'a', minW: 2, maxW: 2, minH: 1, maxH: 1, oldX: 0, oldY: 0, oldW: 2, oldH: 1 },
      { id: 'b', minW: 3, maxW: 3, minH: 1, maxH: 1, oldX: 0, oldY: 3, oldW: 3, oldH: 1 },
    ],
    align: [{ a: 'a', b: 'b', edge: 'hcenter' }],
  };
  // 2*x+2 恒偶，2*x+3 恒奇 → 中心永远无法对齐
  const r = solve(spec);
  assert.equal(r.status, 'infeasible');
});
