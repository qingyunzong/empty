import { test } from "node:test";
import assert from "node:assert/strict";
import { solvePlan, bruteForcePlan, verifyCertificate } from "../src/index.js";
import { mulberry32, randomInstance, normalize } from "./helpers.js";

test("随机算例对拍：DP 求解器与独立全枚举结果完全一致", () => {
  const rand = mulberry32(123456789);
  const cases = 120;
  for (let k = 0; k < cases; k++) {
    const n = 1 + Math.floor(rand() * 8); // 1..8 单
    const v = 1 + Math.floor(rand() * 3); // 1..3 车
    const input = randomInstance(rand, n, v);
    const fast = solvePlan(input);
    const slow = bruteForcePlan(input);
    assert.deepStrictEqual(
      normalize(fast),
      normalize(slow),
      `case ${k} (n=${n}, v=${v}) mismatch`,
    );
    assert.deepStrictEqual(verifyCertificate(input, fast), [], `case ${k} cert invalid`);
    assert.deepStrictEqual(verifyCertificate(input, slow), [], `case ${k} brute cert invalid`);
  }
});

test("较大随机算例对拍：n=10, 2 车", () => {
  const rand = mulberry32(987654321);
  for (let k = 0; k < 5; k++) {
    const input = randomInstance(rand, 10, 2);
    const fast = solvePlan(input);
    const slow = bruteForcePlan(input);
    assert.deepStrictEqual(normalize(fast), normalize(slow), `case ${k} mismatch`);
  }
});

test("对拍覆盖并列情形：大量零费率/等值收益", () => {
  const rand = mulberry32(555);
  for (let k = 0; k < 60; k++) {
    const input = randomInstance(rand, 1 + Math.floor(rand() * 6), 1 + Math.floor(rand() * 3));
    // 强制部分车辆零费率、订单等收益，制造并列
    for (const veh of input.vehicles) veh.costPerUnitTime = rand() < 0.5 ? 0 : 1;
    for (const o of input.orders) o.revenue = rand() < 0.5 ? 5 : o.revenue;
    const fast = solvePlan(input);
    const slow = bruteForcePlan(input);
    assert.deepStrictEqual(normalize(fast), normalize(slow), `tie case ${k} mismatch`);
  }
});
