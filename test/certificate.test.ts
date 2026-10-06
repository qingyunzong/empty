import test from "node:test";
import { equal, ok } from "node:assert/strict";
import { Solver } from "../src/solver.js";
import { buildCertificates, verifyCertificates } from "../src/certificate.js";
import { mulberry32, randomProblem } from "./helpers.js";

test("最优解的逐条证书全部通过", () => {
  const rng = mulberry32(8080);
  for (let iter = 0; iter < 100; iter++) {
    const p = randomProblem(rng);
    const s = new Solver(p);
    s.run();
    const sol = s.result();
    if (!sol) continue;
    const v = verifyCertificates(p, sol);
    ok(v.ok, `第${iter}例证书未通过: ${v.certs.filter((c) => !c.ok).map((c) => c.detail).join("; ")}`);
    // 证书条数 = 用户数 + 2 预算 + 组合数 + 同档数 + 分档数 + 收益合计 + 一致性
    equal(v.certs.length, p.users.length + 2 + p.combos.length + p.sameTier.length + p.diffTier.length + 2);
  }
});

test("篡改解会被证书发现", () => {
  const rng = mulberry32(5150);
  let checked = 0;
  for (let iter = 0; iter < 50 && checked < 5; iter++) {
    const p = randomProblem(rng);
    const s = new Solver(p);
    s.run();
    const sol = s.result();
    if (!sol) continue;
    // 篡改汇总值：一致性证书应失败
    const bad1 = { ...sol, profit: sol.profit + 1 };
    ok(!verifyCertificates(p, bad1).ok);
    // 篡改用量：一致性证书应失败
    const bad2 = { ...sol, used1: sol.used1 + 1 };
    ok(!verifyCertificates(p, bad2).ok);
    checked++;
  }
  ok(checked > 0);
});

test("违反预算的伪造解被预算证书发现", () => {
  const p = {
    users: [[{ r1: 0, r2: 0, profit: 0 }, { r1: 10, r2: 0, profit: 5 }]],
    budget1: 5, budget2: 0,
    combos: [], sameTier: [], diffTier: [],
  };
  const forged = { assign: [1], profit: 5, baseProfit: 5, comboProfit: 0, used1: 10, used2: 0, highCount: 1 };
  const v = verifyCertificates(p, forged);
  ok(!v.ok);
  const budgetCert = buildCertificates(p, forged).find((c) => c.id === "budget:1")!;
  ok(!budgetCert.ok);
});
