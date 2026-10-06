import test from "node:test";
import { deepEqual, equal } from "node:assert/strict";
import { Solver } from "../src/solver.js";
import { Problem } from "../src/types.js";

const solve = (p: Problem) => {
  const s = new Solver(p);
  s.run();
  return s.result();
};

const base: Problem = {
  users: [
    [{ r1: 0, r2: 0, profit: 0 }, { r1: 4, r2: 0, profit: 8 }],
    [{ r1: 0, r2: 0, profit: 0 }, { r1: 4, r2: 0, profit: 8 }],
  ],
  budget1: 8,
  budget2: 0,
  combos: [],
  sameTier: [],
  diffTier: [],
};

test("双资源预算分别生效", () => {
  const p: Problem = {
    users: [
      [{ r1: 0, r2: 0, profit: 0 }, { r1: 6, r2: 0, profit: 10 }],
      [{ r1: 0, r2: 0, profit: 0 }, { r1: 0, r2: 6, profit: 10 }],
    ],
    budget1: 5, budget2: 5,
    combos: [], sameTier: [], diffTier: [],
  };
  const sol = solve(p)!;
  equal(sol.profit, 0); // 两个档都各自超一类预算
  deepEqual(sol.assign, [0, 0]);
});

test("预算不足时用户可不服务", () => {
  const p: Problem = { ...base, budget1: 3 };
  const sol = solve(p)!;
  equal(sol.profit, 0);
  deepEqual(sol.assign, [0, 0]);
});

test("组合收益改变选择", () => {
  const p: Problem = {
    ...base,
    budget1: 4, // 只能服务一个用户
    combos: [{ i: 0, j: 1, ti: 1, tj: 1, bonus: 0 }],
  };
  equal(solve(p)!.profit, 8);
  // 同时选两人档1奖励 9，但预算只够一人 -> 仍为 8
  const p2: Problem = { ...base, budget1: 8, combos: [{ i: 0, j: 1, ti: 1, tj: 1, bonus: 9 }] };
  const sol2 = solve(p2)!;
  equal(sol2.profit, 25);
  equal(sol2.comboProfit, 9);
  deepEqual(sol2.assign, [1, 1]);
});

test("同档约束强制一致", () => {
  const p: Problem = { ...base, budget1: 4, sameTier: [[0, 1]] };
  const sol = solve(p)!;
  // 预算只够一人档1，但同档要求 => 只能都选档0
  equal(sol.profit, 0);
  deepEqual(sol.assign, [0, 0]);
});

test("分档约束强制不同", () => {
  const p: Problem = { ...base, budget1: 8, diffTier: [[0, 1]] };
  const sol = solve(p)!;
  equal(sol.profit, 8);
  // 字典序更小者胜出：[0,1] 优于 [1,0]
  deepEqual(sol.assign, [0, 1]);
});

test("收益相同时优先最高档人数多，再取向量小", () => {
  // [1,1] 与 [1,0] 收益同为 5，但 [1,1] 有 2 人处于各自最高档
  const p: Problem = {
    users: [
      [{ r1: 0, r2: 0, profit: 0 }, { r1: 0, r2: 0, profit: 5 }],
      [{ r1: 0, r2: 0, profit: 0 }, { r1: 0, r2: 0, profit: 0 }],
    ],
    budget1: 0, budget2: 0,
    combos: [], sameTier: [], diffTier: [],
  };
  deepEqual(solve(p)!.assign, [1, 1]);
  // 高档人数也相同时取向量小：[0,1] 优于 [1,0]
  const p2: Problem = {
    users: [
      [{ r1: 0, r2: 0, profit: 0 }, { r1: 2, r2: 0, profit: 5 }],
      [{ r1: 0, r2: 0, profit: 0 }, { r1: 2, r2: 0, profit: 5 }],
    ],
    budget1: 2, budget2: 0,
    combos: [], sameTier: [], diffTier: [],
  };
  const sol2 = solve(p2)!;
  equal(sol2.profit, 5);
  deepEqual(sol2.assign, [0, 1]);
});

test("分档约束可排除全部不服务而导致无可行解", () => {
  const p: Problem = {
    users: [[{ r1: 0, r2: 0, profit: 0 }], [{ r1: 0, r2: 0, profit: 0 }]],
    budget1: 0, budget2: 0,
    combos: [], sameTier: [], diffTier: [[0, 1]],
  };
  equal(solve(p), null);
});
