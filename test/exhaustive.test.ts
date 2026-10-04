import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { solve } from '../src/solver.js';
import { exhaustiveSolve } from '../src/exhaustive.js';
import { allSatisfied, checkLayout } from '../src/constraints.js';
import type { LayoutSpec } from '../src/model.js';

/** T1: 旧位置重叠 + 顶对齐，手工可验证最优为 1。 */
const T1: LayoutSpec = {
  grid: 5,
  rects: [
    { id: 'r1', minW: 1, maxW: 2, minH: 1, maxH: 2, oldX: 0, oldY: 0, oldW: 2, oldH: 2 },
    { id: 'r2', minW: 1, maxW: 2, minH: 1, maxH: 2, oldX: 1, oldY: 1, oldW: 2, oldH: 2 },
  ],
  align: [{ a: 'r1', b: 'r2', edge: 'top' }],
};

/** T2: 旧布局已可行，最优 0。 */
const T2: LayoutSpec = {
  grid: 4,
  rects: [
    { id: 'a', minW: 1, maxW: 2, minH: 1, maxH: 2, oldX: 0, oldY: 0, oldW: 1, oldH: 1 },
    { id: 'b', minW: 1, maxW: 2, minH: 1, maxH: 2, oldX: 2, oldY: 0, oldW: 1, oldH: 1 },
    { id: 'c', minW: 1, maxW: 1, minH: 1, maxH: 1, oldX: 3, oldY: 3, oldW: 1, oldH: 1 },
  ],
  align: [{ a: 'a', b: 'b', edge: 'bottom' }],
};

/** T3: 奇数宽中心对齐 + 潜在重叠，手工难算，专用于交叉校验。 */
const T3: LayoutSpec = {
  grid: 6,
  rects: [
    { id: 'p', minW: 1, maxW: 3, minH: 1, maxH: 2, oldX: 0, oldY: 0, oldW: 3, oldH: 2 },
    { id: 'q', minW: 1, maxW: 3, minH: 1, maxH: 2, oldX: 4, oldY: 0, oldW: 1, oldH: 1 },
  ],
  align: [{ a: 'p', b: 'q', edge: 'hcenter' }],
};

/** T4: 2x2 网格放不下两个 2x2，不可行。 */
const T4: LayoutSpec = {
  grid: 2,
  rects: [
    { id: 'a', minW: 2, maxW: 2, minH: 2, maxH: 2, oldX: 0, oldY: 0, oldW: 2, oldH: 2 },
    { id: 'b', minW: 2, maxW: 2, minH: 2, maxH: 2, oldX: 0, oldY: 0, oldW: 2, oldH: 2 },
  ],
  align: [],
};

/** T5: 三矩形对齐链。 */
const T5: LayoutSpec = {
  grid: 5,
  rects: [
    { id: 'a', minW: 1, maxW: 2, minH: 1, maxH: 2, oldX: 0, oldY: 0, oldW: 1, oldH: 1 },
    { id: 'b', minW: 1, maxW: 2, minH: 1, maxH: 2, oldX: 3, oldY: 0, oldW: 1, oldH: 1 },
    { id: 'c', minW: 1, maxW: 2, minH: 1, maxH: 2, oldX: 1, oldY: 3, oldW: 2, oldH: 1 },
  ],
  align: [
    { a: 'a', b: 'b', edge: 'hcenter' },
    { a: 'b', b: 'c', edge: 'top' },
  ],
};

for (const [name, spec] of Object.entries({ T1, T2, T3, T4, T5 })) {
  test(`交叉校验 ${name}: 分支定界 == 穷举`, () => {
    const bb = solve(spec);
    const ex = exhaustiveSolve(spec);
    assert.equal(bb.objective, ex.objective, `bb=${bb.objective} ex=${ex.objective}`);
    if (bb.objective === null) {
      assert.equal(bb.status, 'infeasible');
      assert.equal(ex.feasibleCount, 0);
    } else {
      assert.equal(bb.status, 'optimal');
      assert.equal(bb.lowerBound, bb.upperBound);
      assert.ok(ex.feasibleCount > 0);
      assert.ok(allSatisfied(checkLayout(spec, bb.layout!)));
      assert.ok(allSatisfied(checkLayout(spec, ex.layout!)));
    }
  });
}

test('T1 最优值确为 1（手工验证）', () => {
  assert.equal(exhaustiveSolve(T1).objective, 1);
  assert.equal(solve(T1).objective, 1);
});

test('T2 旧布局已可行，最优 0', () => {
  assert.equal(exhaustiveSolve(T2).objective, 0);
});
