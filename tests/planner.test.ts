import { test } from "node:test";
import assert from "node:assert/strict";
import {
  MAX_PLUGINS,
  PlanningError,
  solve,
  solveExhaustive,
  validatePlan,
  type Plugin,
} from "../src/planner.js";

test("线性依赖链：按依赖顺序启用并记录每步能力", () => {
  const plugins: Plugin[] = [
    { id: "a", requires: ["s"], provides: ["x"], cost: 1 },
    { id: "b", requires: ["x"], provides: ["y"], cost: 2 },
    { id: "c", requires: ["y"], provides: ["goal"], cost: 3 },
  ];
  const plan = solve(["s"], plugins, ["goal"]);
  assert.equal(plan.feasible, true);
  assert.equal(plan.totalCost, 6);
  assert.deepEqual(
    plan.steps.map((s) => s.plugin),
    ["a", "b", "c"],
  );
  assert.deepEqual(plan.steps[0]!.capabilities.sort(), ["s", "x"]);
  assert.deepEqual(plan.steps[1]!.capabilities.sort(), ["s", "x", "y"]);
  assert.deepEqual(plan.steps[2]!.capabilities.sort(), ["goal", "s", "x", "y"]);
  validatePlan(["s"], plugins, ["goal"], plan);
});

test("多条路径：选择总成本最低者，而非步数最少者", () => {
  const plugins: Plugin[] = [
    { id: "expensive-direct", requires: ["s"], provides: ["goal"], cost: 10 },
    { id: "cheap-1", requires: ["s"], provides: ["m"], cost: 2 },
    { id: "cheap-2", requires: ["m"], provides: ["goal"], cost: 3 },
  ];
  const plan = solve(["s"], plugins, ["goal"]);
  assert.equal(plan.totalCost, 5);
  assert.deepEqual(
    plan.steps.map((s) => s.plugin),
    ["cheap-1", "cheap-2"],
  );
  validatePlan(["s"], plugins, ["goal"], plan);
});

test("循环依赖无法自举：互相提供对方所需能力但无起始支撑", () => {
  const plugins: Plugin[] = [
    { id: "cycle-a", requires: ["cap-b"], provides: ["cap-a"], cost: 1 },
    { id: "cycle-b", requires: ["cap-a"], provides: ["cap-b", "goal"], cost: 1 },
  ];
  const plan = solve([], plugins, ["goal"]);
  assert.equal(plan.feasible, false);
  assert.equal(plan.totalCost, Infinity);
  const ex = solveExhaustive([], plugins, ["goal"]);
  assert.equal(ex.feasible, false);
});

test("自供能力无法自举：requires 与 provides 相同仍须外部先具备", () => {
  const plugins: Plugin[] = [
    { id: "self-boot", requires: ["self-cap"], provides: ["self-cap", "goal"], cost: 1 },
  ];
  assert.equal(solve([], plugins, ["goal"]).feasible, false);
  // 起始能力显式给出后即可启用
  const plan = solve(["self-cap"], plugins, ["goal"]);
  assert.equal(plan.feasible, true);
  assert.equal(plan.totalCost, 1);
});

test("循环可被起始能力打破：显式起始能力使环中插件可启动", () => {
  const plugins: Plugin[] = [
    { id: "cycle-a", requires: ["cap-b"], provides: ["cap-a"], cost: 2 },
    { id: "cycle-b", requires: ["cap-a"], provides: ["cap-b", "goal"], cost: 4 },
  ];
  const plan = solve(["cap-b"], plugins, ["goal"]);
  assert.equal(plan.feasible, true);
  assert.equal(plan.totalCost, 6);
  assert.deepEqual(
    plan.steps.map((s) => s.plugin),
    ["cycle-a", "cycle-b"],
  );
  validatePlan(["cap-b"], plugins, ["goal"], plan);
});

test("无需启用插件：起始能力已覆盖目标时成本为 0", () => {
  const plan = solve(["goal"], [{ id: "x", requires: ["goal"], provides: ["z"], cost: 1 }], ["goal"]);
  assert.equal(plan.feasible, true);
  assert.equal(plan.totalCost, 0);
  assert.equal(plan.steps.length, 0);
});

test("不启用与目标无关的插件", () => {
  const plugins: Plugin[] = [
    { id: "useful", requires: [], provides: ["goal"], cost: 1 },
    { id: "useless", requires: [], provides: ["junk"], cost: 0 },
  ];
  const plan = solve([], plugins, ["goal"]);
  assert.equal(plan.totalCost, 1);
  assert.deepEqual(
    plan.steps.map((s) => s.plugin),
    ["useful"],
  );
});

test("插件数量上限：18 个可解，19 个报错", () => {
  const make = (count: number): Plugin[] =>
    Array.from({ length: count }, (_, i) => ({
      id: `p${i}`,
      requires: i === 0 ? [] : [`c${i - 1}`],
      provides: [`c${i}`],
      cost: 1,
    }));
  const ok = solve([], make(MAX_PLUGINS), [`c${MAX_PLUGINS - 1}`]);
  assert.equal(ok.feasible, true);
  assert.equal(ok.totalCost, MAX_PLUGINS);
  assert.throws(() => solve([], make(MAX_PLUGINS + 1), ["goal"]), PlanningError);
});

test("非法输入：重复 id 与负成本被拒绝", () => {
  const dup: Plugin[] = [
    { id: "a", requires: [], provides: ["x"], cost: 1 },
    { id: "a", requires: [], provides: ["y"], cost: 1 },
  ];
  assert.throws(() => solve([], dup, ["x"]), PlanningError);
  const neg: Plugin[] = [{ id: "a", requires: [], provides: ["x"], cost: -1 }];
  assert.throws(() => solve([], neg, ["x"]), PlanningError);
});

test("穷举状态搜索与主求解器一致（含 18 插件满规模）", () => {
  const plugins: Plugin[] = Array.from({ length: MAX_PLUGINS }, (_, i) => ({
    id: `p${i}`,
    requires: i % 3 === 0 ? [] : [`c${(i - 1) % 9}`],
    provides: [`c${i % 9}`, ...(i === MAX_PLUGINS - 1 ? ["goal"] : [])],
    cost: (i * 7) % 5,
  }));
  const plan = solve([], plugins, ["goal"]);
  const ex = solveExhaustive([], plugins, ["goal"]);
  assert.equal(ex.statesExplored, 1 << MAX_PLUGINS);
  assert.equal(plan.feasible, ex.feasible);
  assert.equal(plan.totalCost, ex.minCost);
  if (plan.feasible) validatePlan([], plugins, ["goal"], plan);
});

test("随机问题交叉核对：solve 与 solveExhaustive 结果一致且计划可重放", () => {
  // 确定性伪随机数（LCG），保证测试可复现。
  let seed = 0x2f6e2b1;
  const rand = (): number => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed / 0x80000000;
  };

  for (let trial = 0; trial < 50; trial++) {
    const n = 1 + Math.floor(rand() * 12);
    const capCount = 2 + Math.floor(rand() * 6);
    const caps = Array.from({ length: capCount }, (_, i) => `cap${i}`);
    const pick = (allowEmpty: boolean): string[] => {
      const out = caps.filter(() => rand() < 0.35);
      if (!allowEmpty && out.length === 0) out.push(caps[Math.floor(rand() * capCount)]!);
      return out;
    };
    const plugins: Plugin[] = Array.from({ length: n }, (_, i) => ({
      id: `p${i}`,
      requires: pick(true),
      provides: pick(false),
      cost: Math.floor(rand() * 10),
    }));
    const initial = pick(true);
    const targets = pick(false);

    const plan = solve(initial, plugins, targets);
    const ex = solveExhaustive(initial, plugins, targets);
    assert.equal(plan.feasible, ex.feasible, `trial ${trial} 可行性不一致`);
    assert.equal(plan.totalCost, ex.minCost, `trial ${trial} 最低成本不一致`);
    if (plan.feasible) validatePlan(initial, plugins, targets, plan);
  }
});
