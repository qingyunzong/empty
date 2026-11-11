import test from 'node:test';
import assert from 'node:assert/strict';

import {
  IDENTITY,
  multiply,
  transformPoint,
  transformAABB,
  unionAABB,
  aabbEquals,
  matEquals,
} from '../dist/math.js';

test('矩阵乘法满足单位元与结合约定', () => {
  const m = [2, 0, 0, 3, 10, 20];
  assert.ok(matEquals(multiply(IDENTITY, m), m));
  assert.ok(matEquals(multiply(m, IDENTITY), m));

  const a = [1, 0, 0, 1, 5, 6];
  const b = [2, 0, 0, 2, 0, 0];
  // 先缩放 2 倍再平移 (5,6) => [2,0,0,2,5,6]
  assert.deepEqual([...multiply(a, b)], [2, 0, 0, 2, 5, 6]);
});

test('点变换按 x = a*x + c*y + e 约定', () => {
  const p = transformPoint([2, 0, 0, 3, 10, 20], { x: 1, y: 1 });
  assert.deepEqual(p, { x: 12, y: 23 });
});

test('剪切矩阵使包围盒扩张，而非简单缩放宽高', () => {
  const unit = { minX: 0, minY: 0, maxX: 1, maxY: 1 };
  // x' = x + y, y' = y
  const shear = [1, 0, 1, 1, 0, 0];
  const box = transformAABB(shear, unit);
  assert.equal(box.minX, 0);
  assert.equal(box.maxX, 2);
  assert.equal(box.minY, 0);
  assert.equal(box.maxY, 1);

  // 角点 (1,0)->(1,0), (0,1)->(1,1), (1,1)->(2,1)
  assert.deepEqual(transformPoint(shear, { x: 1, y: 1 }), { x: 2, y: 1 });
});

test('负缩放翻转 min/max 后仍给出正确 AABB', () => {
  const box = transformAABB([-1, 0, 0, 1, 0, 0], {
    minX: 2,
    minY: 3,
    maxX: 5,
    maxY: 7,
  });
  assert.equal(box.maxX, -2);
  assert.equal(box.minX, -5);
  assert.equal(box.minY, 3);
  assert.equal(box.maxY, 7);

  const both = transformAABB([-2, 0, 0, -3, 0, 0], {
    minX: 1,
    minY: 1,
    maxX: 2,
    maxY: 2,
  });
  assert.deepEqual(both, { minX: -4, minY: -6, maxX: -2, maxY: -3 });
});

test('unionAABB 处理 null 与合并', () => {
  const a = { minX: 0, minY: 0, maxX: 1, maxY: 1 };
  const b = { minX: -1, minY: 2, maxX: 2, maxY: 3 };
  assert.ok(aabbEquals(unionAABB(null, a), a));
  assert.ok(aabbEquals(unionAABB(a, null), a));
  assert.equal(unionAABB(null, null), null);
  assert.deepEqual(unionAABB(a, b), { minX: -1, minY: 0, maxX: 2, maxY: 3 });
});
