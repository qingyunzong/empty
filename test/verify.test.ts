import assert from "node:assert/strict";
import { test } from "node:test";
import { run } from "../src/cli.js";
import { loadScenario } from "../src/scenario.js";
import { solveWarehouse } from "../src/solver.js";
import type { WarehouseInput } from "../src/types.js";
import { checkCertificate, dijkstraOptimum, enumerateOptimum } from "../src/verify.js";
import { mulberry32, randomWarehouse } from "./util.js";

test("三方对照：DP = 独立有限状态搜索 = 短周期枚举（40 个随机场景）", () => {
  const rng = mulberry32(80808);
  for (let i = 0; i < 40; i++) {
    const horizon = 1 + Math.floor(rng() * 4);
    const wh = randomWarehouse(rng, {
      horizon,
      maxCap: 5,
      maxDemand: 4,
      maxLead: 3,
      twoChannels: true,
    });
    const plan = solveWarehouse(wh, horizon, false);
    const dij = dijkstraOptimum(wh, horizon, false);
    const en = enumerateOptimum(wh, horizon, false);
    assert.equal(plan === null, dij === null, `场景 ${i}: DP 与搜索可行性不一致`);
    assert.equal(plan === null, en === null, `场景 ${i}: DP 与枚举可行性不一致`);
    if (plan && dij && en) {
      assert.equal(plan.totalCost, dij.cost, `场景 ${i}: DP ≠ 搜索`);
      assert.equal(plan.totalCost, en.cost, `场景 ${i}: DP ≠ 枚举`);
    }
  }
});

test("证书篡改可被检出", () => {
  const wh: WarehouseInput = {
    id: "V",
    capacity: 10,
    initialInventory: 2,
    holdingCost: 1,
    demand: [2, 2, 2],
    channels: [{ name: "standard", leadTime: 1, fixedCost: 5 }],
  };
  const plan = solveWarehouse(wh, 3, false);
  assert.ok(plan);
  assert.deepEqual(checkCertificate(wh, 3, plan, false), []);

  // 篡改 1：期末库存不守恒
  const bad1 = {
    ...plan,
    days: plan.days.map((d, i) => (i === 1 ? { ...d, endInventory: d.endInventory + 1 } : d)),
  };
  assert.ok(checkCertificate(wh, 3, bad1, false).length > 0, "未检出守恒破坏");

  // 篡改 2：订单量与到货不符
  const bad2 = { ...plan, orders: plan.orders.map((o) => ({ ...o, qty: o.qty + 1 })) };
  assert.ok(checkCertificate(wh, 3, bad2, false).length > 0, "未检出订单/到货不符");

  // 篡改 3：费用虚报
  const bad3 = { ...plan, totalCost: plan.totalCost - 1 };
  assert.ok(checkCertificate(wh, 3, bad3, false).length > 0, "未检出费用虚报");
});

test("examples 场景可求解且通过全部核对", () => {
  const plan = loadScenario("examples/plan.json");
  for (const wh of plan.warehouses) {
    const p = solveWarehouse(wh, plan.horizon, false);
    assert.ok(p, `仓库 ${wh.id} 应可行`);
    assert.deepEqual(checkCertificate(wh, plan.horizon, p, false), []);
    const dij = dijkstraOptimum(wh, plan.horizon, false);
    assert.equal(p.totalCost, dij?.cost);
  }
  const re = loadScenario("examples/replan.json");
  for (const wh of re.warehouses) {
    const p = solveWarehouse(wh, re.horizon, true);
    assert.ok(p, `仓库 ${wh.id} 重规划应可行`);
    assert.deepEqual(checkCertificate(wh, re.horizon, p, true), []);
    const dij = dijkstraOptimum(wh, re.horizon, true);
    assert.equal(p.deviation, dij?.dev);
    assert.equal(p.totalCost, dij?.cost);
  }
});

test("CLI 端到端：plan / replan / verify 退出码与关键输出", () => {
  const outPlan = run(["plan", "examples/plan.json"]);
  assert.equal(outPlan.exitCode, 0);
  assert.match(outPlan.stdout, /总费用: \d+/);
  assert.match(outPlan.stdout, /逐日守恒 ✓/);
  assert.match(outPlan.stdout, /独立有限状态搜索 ✓/);

  const outReplan = run(["replan", "examples/replan.json"]);
  assert.equal(outReplan.exitCode, 0);
  assert.match(outReplan.stdout, /重规划净差/);
  assert.match(outReplan.stdout, /下单量调整量 \|Δ\| 合计 \d+/);
  assert.match(outReplan.stdout, /逐日守恒: ✓+/);

  const outVerify = run(["verify", "examples/replan.json"]);
  assert.equal(outVerify.exitCode, 0);
  assert.match(outVerify.stdout, /证书✓/);

  const bad = run(["plan", "no-such-file.json"]);
  assert.equal(bad.exitCode, 1);
  assert.match(bad.stderr, /无法读取场景文件/);
});
