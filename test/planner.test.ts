import test from "node:test";
import { deepEqual, equal, ok } from "node:assert/strict";
import type { Problem } from "../src/model.js";
import { compareIdSeq, planIds, planUpgrade } from "../src/planner.js";
import { enumerateBest } from "../src/enumerate.js";
import { buildCertificate } from "../src/schedule.js";
import { mulberry32, randomProblem } from "./random-util.js";

function problem(partial: Partial<Problem> & Pick<Problem, "packages">): Problem {
  return { source: "A", target: "D", spaceLimitBytes: 1000, ...partial };
}

test("选择总下载量最小的路径", () => {
  const plan = planUpgrade(problem({
    packages: [
      { id: "p1", from: "A", to: "B", bytes: 5 },
      { id: "p2", from: "B", to: "D", bytes: 5 },
      { id: "p3", from: "A", to: "C", bytes: 2 },
      { id: "p4", from: "C", to: "D", bytes: 2 },
      { id: "p5", from: "A", to: "D", bytes: 20 },
    ],
  }));
  ok(plan !== null);
  equal(plan.totalBytes, 4);
  deepEqual(planIds(plan), ["p3", "p4"]);
});

test("并列时选包 ID 序列字典序最小（含前缀陷阱回归）", () => {
  const plan = planUpgrade(problem({
    packages: [
      { id: "m", from: "A", to: "B", bytes: 1 },
      { id: "a", from: "B", to: "C", bytes: 1 },
      { id: "n", from: "A", to: "C", bytes: 2 },
      { id: "z", from: "C", to: "D", bytes: 1 },
    ],
  }));
  ok(plan !== null);
  equal(plan.totalBytes, 3);
  deepEqual(planIds(plan), ["m", "a", "z"]);
});

test("同费用平行边选字典序更小的包 ID", () => {
  const plan = planUpgrade(problem({
    packages: [
      { id: "p9", from: "A", to: "D", bytes: 5 },
      { id: "p1", from: "A", to: "D", bytes: 5 },
    ],
  }));
  ok(plan !== null);
  deepEqual(planIds(plan), ["p1"]);
});

test("超过空间上限的包被排除；全部排除后无可行方案", () => {
  const packages = [
    { id: "p1", from: "A", to: "B", bytes: 50 },
    { id: "p2", from: "B", to: "D", bytes: 50 },
    { id: "p3", from: "A", to: "D", bytes: 30 },
  ];
  const plan = planUpgrade(problem({ spaceLimitBytes: 40, packages }));
  ok(plan !== null);
  deepEqual(planIds(plan), ["p3"]);
  equal(plan.totalBytes, 30);
  equal(planUpgrade(problem({ spaceLimitBytes: 20, packages })), null);
});

test("起点即终点时为空方案", () => {
  const plan = planUpgrade(problem({ source: "A", target: "A", packages: [] }));
  ok(plan !== null);
  equal(plan.totalBytes, 0);
  deepEqual(planIds(plan), []);
});

test("compareIdSeq 字典序与前缀规则", () => {
  ok(compareIdSeq(["a", "b"], ["a", "c"]) < 0);
  ok(compareIdSeq(["a"], ["a", "b"]) < 0);
  ok(compareIdSeq(["b"], ["a", "b"]) > 0);
  equal(compareIdSeq(["a"], ["a"]), 0);
});

test("随机小图：规划器与枚举对照一致，且空间证书有效", () => {
  const rand = mulberry32(20261006);
  let feasible = 0;
  let infeasible = 0;
  for (let seed = 0; seed < 500; seed += 1) {
    const prob = randomProblem(rand);
    const plan = planUpgrade(prob);
    const enumeration = enumerateBest(prob);
    ok(!enumeration.truncated, "小图枚举不应被截断");
    if (plan === null) {
      equal(enumeration.best, null, `种子 ${seed}: 规划器无解但枚举有解`);
      infeasible += 1;
      continue;
    }
    feasible += 1;
    ok(enumeration.best !== null, `种子 ${seed}: 规划器有解但枚举无解`);
    equal(plan.totalBytes, enumeration.best.totalBytes, `种子 ${seed}: 总下载量不一致`);
    deepEqual(planIds(plan), planIds(enumeration.best), `种子 ${seed}: 包序列不一致`);
    const cert = buildCertificate(prob, plan);
    ok(cert.ok, `种子 ${seed}: 空间证书校验失败: ${cert.problems.join("; ")}`);
    ok(cert.peakBytes <= prob.spaceLimitBytes);
  }
  ok(feasible > 100, `可行样本过少: ${feasible}`);
  ok(infeasible > 20, `不可行样本过少: ${infeasible}`);
});
