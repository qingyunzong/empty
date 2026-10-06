import assert from "node:assert/strict";
import test from "node:test";
import { orderCost, unitPriceFor } from "../src/pricing.js";
import {
  enumerateProcurement,
  maskFeasible,
  solveProcurement,
} from "../src/procurement.js";
import type { ProcurementInput, Supplier } from "../src/types.js";
import { validateProcurement } from "../src/validate.js";
import { mulberry32, randInt } from "./helpers.js";

const sup = (name: string, minQty: number, maxQty: number, tiers: [number, number][]): Supplier => ({
  name,
  minQty,
  maxQty,
  tiers: tiers.map(([upTo, unitPrice]) => ({ upTo, unitPrice })),
});

test("全量阶梯单价：按总量所在档位对全部数量计价", () => {
  const s = sup("A", 1, 60, [[30, 5], [60, 4]]);
  assert.equal(unitPriceFor(s, 30), 5);
  assert.equal(unitPriceFor(s, 31), 4);
  assert.equal(orderCost(s, 0), 0);
  assert.equal(orderCost(s, 31), 124);
});

test("手工算例：两家供应商取最便宜组合", () => {
  const input: ProcurementInput = {
    demand: 10,
    maxTotal: 30,
    suppliers: [
      sup("A", 5, 20, [[20, 3]]),
      sup("B", 8, 20, [[20, 4]]),
    ],
  };
  const res = solveProcurement(input);
  assert.equal(res.feasible, true);
  assert.deepEqual(res.quantities, [10, 0]);
  assert.equal(res.totalCost, 30);
  assert.equal(res.overPurchase, 0);
});

test("最低起订量约束导致超购", () => {
  const input: ProcurementInput = {
    demand: 3,
    maxTotal: 10,
    suppliers: [sup("A", 5, 10, [[10, 2]])],
  };
  const res = solveProcurement(input);
  assert.equal(res.feasible, true);
  assert.deepEqual(res.quantities, [5]);
  assert.equal(res.overPurchase, 2);
});

test("互斥约束：两家只能选一家", () => {
  const input: ProcurementInput = {
    demand: 10,
    maxTotal: 20,
    suppliers: [
      sup("A", 5, 20, [[20, 2]]),
      sup("B", 5, 20, [[20, 3]]),
    ],
    mutex: [[0, 1]],
  };
  const res = solveProcurement(input);
  assert.equal(res.feasible, true);
  assert.deepEqual(res.quantities, [10, 0]);
  assert.equal(maskFeasible(0b11, [[0, 1]], []), false);
  assert.equal(maskFeasible(0b01, [[0, 1]], []), true);
});

test("依赖约束：选 C 必须同时选 D", () => {
  const input: ProcurementInput = {
    demand: 10,
    maxTotal: 30,
    suppliers: [
      sup("A", 10, 20, [[20, 5]]),
      sup("B", 4, 20, [[20, 1]]),
    ],
    depends: [[1, 0]],
  };
  const res = solveProcurement(input);
  assert.equal(res.feasible, true);
  assert.deepEqual(res.quantities, [10, 0]);
  assert.equal(maskFeasible(0b10, [], [[1, 0]]), false);
  assert.equal(maskFeasible(0b11, [], [[1, 0]]), true);
});

test("平局裁决：先总价，再超购，再数量向量字典序", () => {
  const input: ProcurementInput = {
    demand: 10,
    maxTotal: 20,
    suppliers: [
      sup("A", 1, 20, [[20, 2]]),
      sup("B", 1, 20, [[20, 2]]),
    ],
  };
  const res = solveProcurement(input);
  assert.equal(res.totalCost, 20);
  assert.equal(res.overPurchase, 0);
  assert.deepEqual(res.quantities, [0, 10]);
});

test("超购更少者优先于向量字典序", () => {
  const input: ProcurementInput = {
    demand: 9,
    maxTotal: 20,
    suppliers: [
      sup("A", 1, 20, [[20, 2]]),
      sup("B", 10, 20, [[20, 1.8]]),
    ],
  };
  const res = solveProcurement(input);
  assert.equal(res.totalCost, 18);
  assert.equal(res.overPurchase, 0);
  assert.deepEqual(res.quantities, [9, 0]);
});

test("不可行情形：上限无法满足需求", () => {
  const input: ProcurementInput = {
    demand: 100,
    maxTotal: 100,
    suppliers: [sup("A", 1, 80, [[80, 1]])],
  };
  const res = solveProcurement(input);
  assert.equal(res.feasible, false);
});

test("输入校验：拒绝非法配置", () => {
  const base: ProcurementInput = {
    demand: 10,
    maxTotal: 20,
    suppliers: [sup("A", 1, 10, [[10, 1]])],
  };
  assert.doesNotThrow(() => validateProcurement(base));
  assert.throws(() =>
    validateProcurement({ ...base, suppliers: [...base.suppliers, ...Array.from({ length: 8 }, (_, i) => sup(`S${i}`, 1, 10, [[10, 1]]))] }),
  );
  assert.throws(() =>
    validateProcurement({ ...base, suppliers: [sup("A", 1, 81, [[81, 1]])] }),
  );
  assert.throws(() =>
    validateProcurement({ ...base, suppliers: [sup("A", 5, 10, [[10, 2], [4, 1]])] }),
  );
  assert.throws(() =>
    validateProcurement({ ...base, suppliers: [sup("A", 1, 10, [[5, 1]])] }),
  );
  assert.throws(() => validateProcurement({ ...base, demand: 30 }));
  assert.throws(() => validateProcurement({ ...base, mutex: [[0, 3]] }));
});

function randomInput(rng: () => number): ProcurementInput {
  const n = randInt(rng, 1, 4);
  const suppliers: Supplier[] = [];
  for (let i = 0; i < n; i++) {
    const minQty = randInt(rng, 1, 3);
    const maxQty = minQty + randInt(rng, 0, 4);
    const tiers: [number, number][] = [];
    const price = randInt(rng, 2, 6);
    if (maxQty >= 2 && rng() < 0.5) {
      const mid = randInt(rng, 1, maxQty - 1);
      tiers.push([mid, price]);
      tiers.push([maxQty, Math.max(1, price - randInt(rng, 0, 2))]);
    } else {
      tiers.push([maxQty, price]);
    }
    suppliers.push(sup(`S${i}`, minQty, maxQty, tiers));
  }
  const demand = randInt(rng, 0, 12);
  const maxTotal = demand + randInt(rng, 0, 8);
  const mutex: [number, number][] = [];
  const depends: [number, number][] = [];
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      if (rng() < 0.15) mutex.push([i, j]);
      else if (rng() < 0.1) depends.push([j, i]);
    }
  }
  return { demand, maxTotal, suppliers, mutex, depends };
}

test("随机小例：DP 与枚举完全一致（200 组）", () => {
  const rng = mulberry32(20261006);
  for (let iter = 0; iter < 200; iter++) {
    const input = randomInput(rng);
    validateProcurement(input);
    const dp = solveProcurement(input);
    const brute = enumerateProcurement(input);
    assert.equal(dp.feasible, brute.feasible, `iter=${iter} input=${JSON.stringify(input)}`);
    assert.equal(dp.totalCost, brute.totalCost, `iter=${iter}`);
    assert.equal(dp.totalQuantity, brute.totalQuantity, `iter=${iter}`);
    assert.deepEqual(dp.quantities, brute.quantities, `iter=${iter}`);
  }
});
