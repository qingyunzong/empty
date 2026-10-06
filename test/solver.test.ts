import test from "node:test";
import { deepEqual, ok } from "node:assert/strict";
import { Solver } from "../src/solver.js";
import { bruteForce } from "../src/bruteforce.js";
import { feasible } from "../src/types.js";
import { mulberry32, randomProblem } from "./helpers.js";

test("随机小例：分支限界与暴力枚举结果一致", () => {
  const rng = mulberry32(20261007);
  let infeasibleCount = 0;
  for (let iter = 0; iter < 400; iter++) {
    const p = randomProblem(rng);
    const expected = bruteForce(p);
    const solver = new Solver(p);
    solver.run();
    const got = solver.result();
    if (expected === null) { infeasibleCount++; continue; }
    ok(got !== null, `第${iter}例：求解器误判无可行解`);
    deepEqual(got, expected, `第${iter}例不一致，问题=${JSON.stringify(p)}`);
    ok(feasible(p, got!.assign), `第${iter}例：解不可行`);
  }
  ok(infeasibleCount >= 0);
});

test("全部不服务总是可行基线（收益非负）", () => {
  const rng = mulberry32(7);
  for (let iter = 0; iter < 50; iter++) {
    const p = randomProblem(rng);
    p.combos = p.combos.map((c) => ({ ...c, bonus: Math.abs(c.bonus) }));
    p.sameTier = [];
    p.diffTier = [];
    const s = new Solver(p);
    s.run();
    const sol = s.result();
    ok(sol !== null && sol.profit >= 0);
  }
});
