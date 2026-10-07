import assert from "node:assert/strict";
import { test } from "node:test";
import { solveWarehouse } from "../src/solver.js";
import type { WarehouseInput } from "../src/types.js";
import { checkCertificate, dijkstraOptimum, enumerateOptimum } from "../src/verify.js";
import { makeReplanCase, mulberry32 } from "./util.js";

const BASE: WarehouseInput = {
  id: "R",
  capacity: 10,
  initialInventory: 0,
  holdingCost: 1,
  demand: [3, 0],
  channels: [{ name: "standard", leadTime: 0, fixedCost: 5 }],
};

test("需求未变时重规划保持已公布下单量（偏差 0）", () => {
  const wh: WarehouseInput = {
    ...BASE,
    published: [{ day: 0, channel: "standard", qty: 3, locked: 0 }],
  };
  const plan = solveWarehouse(wh, 2, true);
  assert.ok(plan);
  assert.equal(plan.deviation, 0);
  assert.deepEqual(
    plan.orders.map((o) => [o.day, o.qty]),
    [[0, 3]],
  );
});

test("字典序目标：先最少改已公布量，再总费少", () => {
  // 需求由 5 更正为 3：保持已公布 5 件费用更高(9)，但偏差最小(0)，应被选中
  const wh: WarehouseInput = {
    ...BASE,
    published: [{ day: 0, channel: "standard", qty: 5, locked: 0 }],
  };
  const plan = solveWarehouse(wh, 2, true);
  assert.ok(plan);
  assert.equal(plan.deviation, 0);
  assert.equal(plan.orders[0]!.qty, 5);
  assert.equal(plan.totalCost, 5 + 1 * 2 + 1 * 2); // 启单 5 + 两天期末 2 件持有
  // 对照：纯费用最优会撤到 3 件，总费 5，但偏差为 2
  const fresh = solveWarehouse({ ...BASE, published: [] }, 2, false);
  assert.ok(fresh);
  assert.equal(fresh.totalCost, 5);
  assert.ok(plan.totalCost > fresh.totalCost, "字典序：偏差优先于费用");
});

test("锁定部分不可撤销", () => {
  const wh: WarehouseInput = {
    ...BASE,
    demand: [0, 0], // 需求归零
    published: [{ day: 0, channel: "standard", qty: 6, locked: 4 }],
  };
  const plan = solveWarehouse(wh, 2, true);
  assert.ok(plan);
  const qty = plan.orders.find((o) => o.day === 0)?.qty ?? 0;
  assert.ok(qty >= 4, `锁定 4 件不可撤销，实际 ${qty}`);
  // 字典序：偏差优先，仓容允许时保持已公布 6 件（即便持有费更高）
  assert.equal(qty, 6);
  assert.equal(plan.deviation, 0);
});

test("仓容迫使撤销未锁定部分", () => {
  const wh: WarehouseInput = {
    ...BASE,
    capacity: 4,
    demand: [0, 0],
    published: [{ day: 0, channel: "standard", qty: 5, locked: 1 }],
  };
  const plan = solveWarehouse(wh, 2, true);
  assert.ok(plan);
  assert.equal(plan.orders[0]!.qty, 4); // 5 件超仓容，撤到 4
  assert.equal(plan.deviation, 1);
});

test("在途订单（下单日 < 0）只能撤销未锁定部分、不可增量", () => {
  const wh: WarehouseInput = {
    id: "R5",
    capacity: 10,
    initialInventory: 0,
    holdingCost: 1,
    demand: [0, 3, 0],
    channels: [{ name: "standard", leadTime: 2, fixedCost: 5 }],
    published: [{ day: 1, channel: "standard", qty: 4, locked: 2 }], // 下单日 -1，在途
  };
  const plan = solveWarehouse(wh, 3, true);
  assert.ok(plan);
  const qty = plan.orders.find((o) => o.day === 1)?.qty ?? 0;
  assert.ok(qty <= 4, `在途订单不可增量，实际 ${qty}`);
  assert.ok(qty >= 2, `锁定部分不可撤销，实际 ${qty}`);
  assert.equal(qty, 4); // 偏差优先：保持已公布量
  assert.equal(plan.deviation, 0);
});

test("重规划 DP 与短周期枚举对照一致（80 个随机场景）", () => {
  const rng = mulberry32(31337);
  for (let i = 0; i < 80; i++) {
    const horizon = 1 + Math.floor(rng() * 4); // 1..4 天
    const { wh } = makeReplanCase(rng, {
      horizon,
      maxCap: 5,
      maxDemand: 4,
      maxLead: 3,
      twoChannels: true,
    });
    const plan = solveWarehouse(wh, horizon, true);
    const en = enumerateOptimum(wh, horizon, true);
    if (!plan) {
      assert.equal(en, null, `场景 ${i}: DP 不可行但枚举有解`);
      continue;
    }
    assert.ok(en, `场景 ${i}: DP 有解但枚举不可行`);
    assert.equal(plan.deviation, en.dev, `场景 ${i}: 最小偏差不一致`);
    assert.equal(plan.totalCost, en.cost, `场景 ${i}: 同偏差下费用不一致`);
  }
});

test("重规划 DP 与独立有限状态搜索一致（50 个随机场景, 含 12 天）", () => {
  const rng = mulberry32(555);
  for (let i = 0; i < 50; i++) {
    const horizon = 1 + Math.floor(rng() * 12);
    const { wh } = makeReplanCase(rng, {
      horizon,
      maxCap: 18,
      maxDemand: 7,
      maxLead: 4,
      twoChannels: true,
    });
    const plan = solveWarehouse(wh, horizon, true);
    const dij = dijkstraOptimum(wh, horizon, true);
    if (!plan) {
      assert.equal(dij, null, `场景 ${i}: DP 不可行但有限状态搜索有解`);
      continue;
    }
    assert.ok(dij, `场景 ${i}: DP 有解但有限状态搜索不可行`);
    assert.equal(plan.deviation, dij.dev, `场景 ${i}: 最小偏差不一致`);
    assert.equal(plan.totalCost, dij.cost, `场景 ${i}: 同偏差下费用不一致`);
    assert.deepEqual(checkCertificate(wh, horizon, plan, true), [], `场景 ${i}: 证书校验失败`);
  }
});
