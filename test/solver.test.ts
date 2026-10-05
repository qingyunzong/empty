import { test } from "node:test";
import assert from "node:assert/strict";
import { problem } from "../src/data";
import { MAX_PLUGINS, solve, validateProblem } from "../src/solver";
import { bruteForceMinCost, verifyByRelaxation } from "../src/bruteforce";
import { formatPlan } from "../src/format";
import { Plan, Problem, Plugin } from "../src/types";

function assertPlanValid(p: Problem, plan: Plan): void {
  const held = new Set(plan.initial);
  for (const cap of p.initial) assert.ok(held.has(cap), `initial capability ${cap} missing`);
  const used = new Set<string>();
  let cost = 0;
  for (const step of plan.steps) {
    const plugin = step.plugin;
    assert.ok(!used.has(plugin.id), `plugin ${plugin.id} enabled twice`);
    used.add(plugin.id);
    for (const req of plugin.requires) {
      assert.ok(held.has(req), `plugin ${plugin.id} requires ${req} before it is held`);
    }
    for (const prov of plugin.provides) held.add(prov);
    cost += plugin.cost;
    assert.deepEqual([...step.heldAfter].sort(), [...held].sort(), `held set mismatch after ${plugin.id}`);
  }
  for (const cap of p.target) assert.ok(held.has(cap), `target capability ${cap} not reached`);
  assert.equal(cost, plan.totalCost, "plan cost mismatch");
}

test("数据集：三种方法得到一致最优成本 19", () => {
  const plan = solve(problem);
  assert.ok(plan, "expected a feasible plan");
  assert.equal(plan.totalCost, 19);
  const bf = bruteForceMinCost(problem);
  assert.ok(bf);
  assert.equal(bf.cost, 19);
  assert.equal(verifyByRelaxation(problem), 19);
});

test("数据集：返回序列逐步合法且覆盖目标", () => {
  const plan = solve(problem);
  assert.ok(plan);
  assertPlanValid(problem, plan);
  const bf = bruteForceMinCost(problem);
  assert.ok(bf);
  assertPlanValid(problem, bf.plan);
});

test("循环自供：插件不能靠自身提供的能力启动", () => {
  const p: Problem = {
    initial: [],
    target: ["bootstrap"],
    plugins: [{ id: "bootstrapper", cost: 1, requires: ["bootstrap"], provides: ["bootstrap"] }],
  };
  assert.equal(solve(p), null);
  assert.equal(bruteForceMinCost(p), null);
  assert.equal(verifyByRelaxation(p), null);
});

test("互相依赖的二元环：双方都无法启动", () => {
  const p: Problem = {
    initial: [],
    target: ["cap-a"],
    plugins: [
      { id: "cycle-a", cost: 1, requires: ["cap-b"], provides: ["cap-a"] },
      { id: "cycle-b", cost: 1, requires: ["cap-a"], provides: ["cap-b"] },
    ],
  };
  assert.equal(solve(p), null);
  assert.equal(bruteForceMinCost(p), null);
  assert.equal(verifyByRelaxation(p), null);
});

test("环中一个插件可被外部能力点燃，另一个仍不行", () => {
  const p: Problem = {
    initial: ["seed-b"],
    target: ["cap-a"],
    plugins: [
      { id: "cycle-a", cost: 4, requires: ["cap-b"], provides: ["cap-a"] },
      { id: "cycle-b", cost: 1, requires: ["cap-a"], provides: ["cap-b"] },
      { id: "seeder", cost: 2, requires: ["seed-b"], provides: ["cap-b"] },
    ],
  };
  const plan = solve(p);
  assert.ok(plan);
  assert.equal(plan.totalCost, 6); // seeder(2) + cycle-a(4)
  assert.deepEqual(plan.steps.map((s) => s.plugin.id), ["seeder", "cycle-a"]);
});

test("目标已被初始能力满足：空序列，成本 0", () => {
  const p: Problem = {
    initial: ["a", "b"],
    target: ["a"],
    plugins: [{ id: "x", cost: 1, requires: ["a"], provides: ["c"] }],
  };
  const plan = solve(p);
  assert.ok(plan);
  assert.equal(plan.totalCost, 0);
  assert.equal(plan.steps.length, 0);
});

test("贪心陷阱：便宜插件占位的组合并非最优", () => {
  // 直接买 goal 要 100；先买 mid(1) 再买 goal 要 1+2=3。
  const p: Problem = {
    initial: ["seed"],
    target: ["goal"],
    plugins: [
      { id: "direct", cost: 100, requires: ["seed"], provides: ["goal"] },
      { id: "mid", cost: 1, requires: ["seed"], provides: ["mid"] },
      { id: "via-mid", cost: 2, requires: ["mid"], provides: ["goal"] },
    ],
  };
  const plan = solve(p);
  assert.ok(plan);
  assert.equal(plan.totalCost, 3);
});

test("超过 18 个插件：校验拒绝", () => {
  const plugins: Plugin[] = [];
  for (let i = 0; i < MAX_PLUGINS + 1; i++) {
    plugins.push({ id: `p${i}`, cost: 1, requires: [], provides: [`c${i}`] });
  }
  assert.throws(() => validateProblem({ initial: [], plugins, target: ["c0"] }), /too many plugins/);
});

test("恰好 18 个插件：可求解且与穷举一致", () => {
  const plugins: Plugin[] = [];
  for (let i = 0; i < MAX_PLUGINS; i++) {
    plugins.push({ id: `p${i}`, cost: i + 1, requires: i === 0 ? [] : [`c${i - 1}`], provides: [`c${i}`] });
  }
  const p: Problem = { initial: [], plugins, target: [`c${MAX_PLUGINS - 1}`] };
  const plan = solve(p);
  assert.ok(plan);
  const expected = (MAX_PLUGINS * (MAX_PLUGINS + 1)) / 2;
  assert.equal(plan.totalCost, expected);
  const bf = bruteForceMinCost(p);
  assert.ok(bf);
  assert.equal(bf.cost, expected);
});

test("formatPlan：逐步输出已具能力且单调增长", () => {
  const plan = solve(problem);
  assert.ok(plan);
  const out = formatPlan(plan);
  assert.ok(out.includes("step 0 (initial): held = { git, node }"));
  assert.ok(out.includes("total cost: 19"));
  const stepLines = out.split("\n").filter((l) => /^step \d+: enable /.test(l));
  assert.equal(stepLines.length, plan.steps.length);
  for (let i = 1; i < plan.steps.length; i++) {
    const prev = plan.steps[i - 1]!.heldAfter;
    const curr = plan.steps[i]!.heldAfter;
    for (const cap of prev) assert.ok(curr.includes(cap), "held capabilities must grow monotonically");
    assert.ok(curr.length > prev.length, "each step must add at least one capability");
  }
});

// 确定性伪随机数（mulberry32），用于可复现的随机交叉核对。
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

test("随机实例交叉核对：Dijkstra == 子集穷举 == 全状态松弛（300 例）", () => {
  const rand = mulberry32(20261006);
  const pick = (n: number) => Math.floor(rand() * n);
  for (let iter = 0; iter < 300; iter++) {
    const capCount = 1 + pick(6);
    const caps = Array.from({ length: capCount }, (_, i) => `c${i}`);
    const pluginCount = 1 + pick(10);
    const plugins: Plugin[] = [];
    for (let i = 0; i < pluginCount; i++) {
      const reqCount = pick(3);
      const requires = new Set<string>();
      for (let r = 0; r < reqCount; r++) requires.add(caps[pick(capCount)]!);
      const provides = new Set<string>();
      const provCount = 1 + pick(2);
      for (let r = 0; r < provCount; r++) provides.add(caps[pick(capCount)]!);
      plugins.push({ id: `p${i}`, cost: 1 + pick(9), requires: [...requires], provides: [...provides] });
    }
    const initial = [caps[pick(capCount)]!];
    const target = [caps[pick(capCount)]!];
    const p: Problem = { initial, plugins, target };

    const plan = solve(p);
    const bf = bruteForceMinCost(p);
    const relax = verifyByRelaxation(p);

    const planCost = plan ? plan.totalCost : null;
    const bfCost = bf ? bf.cost : null;
    assert.equal(planCost, bfCost, `iter ${iter}: solve vs bruteForce mismatch`);
    assert.equal(planCost, relax, `iter ${iter}: solve vs relaxation mismatch`);
    if (plan) assertPlanValid(p, plan);
  }
});
