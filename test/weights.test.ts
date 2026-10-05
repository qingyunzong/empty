import test from "node:test";
import assert from "node:assert/strict";
import {
  GAP_CAP,
  PHASE_PERIOD,
  distanceToMissing,
  effectiveWeight,
  phaseFactor,
  proximityFactor,
} from "../src/weights.js";
import type { Cell } from "../src/types.js";

test("时间相位因子按周期循环", () => {
  const seq = Array.from({ length: 2 * PHASE_PERIOD + 1 }, (_, t) => phaseFactor(t));
  assert.deepEqual(seq, [1, 2, 3, 4, 1, 2, 3, 4, 1]);
});

test("缺测距离：前后最近缺测位置，越界按上限计", () => {
  const cells: Cell[] = [
    { value: 1, weight: 1 },
    null,
    { value: 2, weight: 1 },
    { value: 3, weight: 1 },
    { value: 4, weight: 1 },
  ];
  assert.equal(distanceToMissing(cells, 0, -1), GAP_CAP); // 左边界
  assert.equal(distanceToMissing(cells, 0, 1), 1); // t=1 缺测
  assert.equal(distanceToMissing(cells, 2, -1), 1); // t=1 缺测
  assert.equal(distanceToMissing(cells, 4, -1), GAP_CAP); // 3 步内无缺测
  assert.equal(distanceToMissing(cells, 4, 1), GAP_CAP); // 右边界
  assert.equal(distanceToMissing(cells, 3, -1), 2); // t=1 缺测
});

test("邻近因子由前后距离共同决定", () => {
  assert.equal(proximityFactor(1, 1), 4);
  assert.equal(proximityFactor(2, 3), 12);
  assert.equal(proximityFactor(GAP_CAP, GAP_CAP), 16);
});

test("有效权重 = 输入权重 × 相位 × 邻近因子", () => {
  assert.equal(effectiveWeight(2, 2, 1, 3), 2 * 3 * 8);
  assert.equal(effectiveWeight(0, 3, 2, 2), 0); // 零输入权重仍为零
});
