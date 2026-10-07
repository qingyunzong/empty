import assert from "node:assert/strict";
import { test } from "node:test";
import { solveScenario, solveWarehouse } from "../src/solver.js";
import type { WarehouseInput } from "../src/types.js";
import { checkCertificate, dijkstraOptimum, enumerateOptimum } from "../src/verify.js";
import { mulberry32, randomWarehouse } from "./util.js";

test("DP 与短周期枚举对照一致（新计划, 120 个随机小场景）", () => {
  const rng = mulberry32(20261007);
  for (let i = 0; i < 120; i++) {
    const horizon = 1 + Math.floor(rng() * 4); // 1..4 天
    const wh = randomWarehouse(rng, {
      horizon,
      maxCap: 5,
      maxDemand: 4,
      maxLead: 3,
      twoChannels: true,
    });
    const plan = solveWarehouse(wh, horizon, false);
    const en = enumerateOptimum(wh, horizon, false);
    if (!plan) {
      assert.equal(en, null, `场景 ${i}: DP 不可行但枚举有解`);
      continue;
    }
    assert.ok(en, `场景 ${i}: DP 有解但枚举不可行`);
    assert.equal(plan.totalCost, en.cost, `场景 ${i}: 最优费用不一致`);
  }
});

test("DP 与独立有限状态搜索一致（新计划, 60 个随机场景, 含 12 天）", () => {
  const rng = mulberry32(777);
  for (let i = 0; i < 60; i++) {
    const horizon = 1 + Math.floor(rng() * 12); // 1..12 天
    const wh = randomWarehouse(rng, {
      horizon,
      maxCap: 20,
      maxDemand: 8,
      maxLead: 4,
      twoChannels: true,
    });
    const plan = solveWarehouse(wh, horizon, false);
    const dij = dijkstraOptimum(wh, horizon, false);
    if (!plan) {
      assert.equal(dij, null, `场景 ${i}: DP 不可行但有限状态搜索有解`);
      continue;
    }
    assert.ok(dij, `场景 ${i}: DP 有解但有限状态搜索不可行`);
    assert.equal(plan.totalCost, dij.cost, `场景 ${i}: 最优费用不一致`);
    assert.deepEqual(checkCertificate(wh, horizon, plan, false), [], `场景 ${i}: 证书校验失败`);
  }
});

test("手算已知答案：标准渠道，合并下单省启单费", () => {
  const wh: WarehouseInput = {
    id: "T1",
    capacity: 10,
    initialInventory: 2,
    holdingCost: 1,
    demand: [2, 2, 2],
    channels: [{ name: "standard", leadTime: 1, fixedCost: 5 }],
  };
  const plan = solveWarehouse(wh, 3, false);
  assert.ok(plan);
  // 第 1 天到货 4 件：启单费 5 + 持有费 2 = 7（优于分两次下单的 10）
  assert.equal(plan.totalCost, 7);
  assert.deepEqual(
    plan.orders.map((o) => [o.day, o.channel, o.qty]),
    [[1, "standard", 4]],
  );
});

test("标准提前期来不及到货时使用加急渠道", () => {
  const wh: WarehouseInput = {
    id: "T2",
    capacity: 10,
    initialInventory: 0,
    holdingCost: 1,
    demand: [0, 3, 0],
    channels: [
      { name: "standard", leadTime: 3, fixedCost: 5 },
      { name: "expedited", leadTime: 1, fixedCost: 20 },
    ],
  };
  const plan = solveWarehouse(wh, 3, false);
  assert.ok(plan);
  assert.equal(plan.totalCost, 20);
  assert.deepEqual(
    plan.orders.map((o) => [o.day, o.channel, o.qty]),
    [[1, "expedited", 3]],
  );
});

test("禁止缺货下的不可行判定", () => {
  const wh: WarehouseInput = {
    id: "T3",
    capacity: 4,
    initialInventory: 1,
    holdingCost: 1,
    demand: [5, 0],
    channels: [{ name: "standard", leadTime: 1, fixedCost: 5 }],
  };
  assert.equal(solveWarehouse(wh, 2, false), null);
  assert.equal(dijkstraOptimum(wh, 2, false), null);
  assert.equal(enumerateOptimum(wh, 2, false), null);
});

test("多仓独立求解：总费用等于各仓独立求解之和", () => {
  const rng = mulberry32(42);
  const horizon = 12;
  const wa = randomWarehouse(rng, { horizon, maxCap: 25, maxDemand: 8, maxLead: 3, twoChannels: true });
  const wb = { ...randomWarehouse(rng, { horizon, maxCap: 15, maxDemand: 6, maxLead: 2, twoChannels: true }), id: "B" };
  wa.id = "A";
  const res = solveScenario({ horizon, warehouses: [wa, wb] }, false);
  const pa = solveWarehouse(wa, horizon, false);
  const pb = solveWarehouse(wb, horizon, false);
  assert.equal(res.feasible, pa !== null && pb !== null);
  if (res.feasible) {
    assert.equal(res.totalCost, pa!.totalCost + pb!.totalCost);
  }
});

test("整数下单：所有订单量与库存均为整数", () => {
  const rng = mulberry32(9);
  for (let i = 0; i < 20; i++) {
    const horizon = 1 + Math.floor(rng() * 12);
    const wh = randomWarehouse(rng, { horizon, maxCap: 20, maxDemand: 8, maxLead: 3, twoChannels: true });
    const plan = solveWarehouse(wh, horizon, false);
    if (!plan) continue;
    for (const o of plan.orders) assert.ok(Number.isInteger(o.qty) && o.qty > 0);
    for (const d of plan.days) {
      assert.ok(Number.isInteger(d.startInventory) && Number.isInteger(d.endInventory));
    }
  }
});
