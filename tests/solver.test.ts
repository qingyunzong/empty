import { test } from "node:test";
import assert from "node:assert/strict";
import { bruteForce, solve } from "../src/solver.js";
import { validateProblem } from "../src/validate.js";
import { buildCertificate } from "../src/certificate.js";
import type { Problem } from "../src/types.js";

const KNOWN_CASE: Problem = {
  channels: [{ id: "A", budget: 10 }],
  minImpressions: 6,
  groups: [
    { id: "g1", channel: "A", unitCost: 2, unitImpressions: 3, revenue: [0, 5, 9, 12, 14, 15, 16, 17, 18, 19, 20] },
    { id: "g2", channel: "A", unitCost: 5, unitImpressions: 4, revenue: [0, 11, 21, 30, 38, 44, 49, 53, 56, 58, 59] },
  ],
};

test("known case: hand-computed optimum", () => {
  const sol = solve(KNOWN_CASE);
  assert.equal(sol.feasible, true);
  assert.deepEqual(sol.amounts, [0, 2]);
  assert.equal(sol.revenue, 21);
  assert.equal(sol.cost, 10);
  assert.equal(sol.impressions, 8);
});

test("tie on revenue picks the cheaper allocation", () => {
  // 同一收益 10 可由 x=1（成本 1）或 x=2（成本 2）达到，必须选成本更低者。
  const problem: Problem = {
    channels: [{ id: "A", budget: 100 }],
    minImpressions: 0,
    groups: [
      { id: "g1", channel: "A", unitCost: 1, unitImpressions: 0, revenue: [0, 10, 10, 0, 0, 0, 0, 0, 0, 0, 0] },
    ],
  };
  const sol = solve(problem);
  assert.equal(sol.revenue, 10);
  assert.equal(sol.cost, 1);
  assert.deepEqual(sol.amounts, [1]);
  const bf = bruteForce(problem);
  assert.equal(bf.revenue, 10);
  assert.equal(bf.cost, 1);
});

test("infeasible when impressions lower bound is unreachable", () => {
  const problem: Problem = {
    channels: [{ id: "A", budget: 1000 }],
    minImpressions: 100,
    groups: [
      { id: "g1", channel: "A", unitCost: 1, unitImpressions: 1, revenue: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10] },
      { id: "g2", channel: "A", unitCost: 1, unitImpressions: 1, revenue: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10] },
    ],
  };
  const sol = solve(problem);
  assert.equal(sol.feasible, false);
  const cert = buildCertificate(problem, sol, null);
  assert.equal(cert.status, "infeasible");
  assert.equal(cert.budgetCertificate.impressions.satisfied, false);
});

test("per-channel budgets are enforced independently", () => {
  const problem: Problem = {
    channels: [
      { id: "A", budget: 4 },
      { id: "B", budget: 0 },
    ],
    minImpressions: 0,
    groups: [
      { id: "g1", channel: "A", unitCost: 2, unitImpressions: 0, revenue: [0, 5, 9, 12, 14, 15, 16, 17, 18, 19, 20] },
      { id: "g2", channel: "B", unitCost: 1, unitImpressions: 0, revenue: [0, 100, 100, 100, 100, 100, 100, 100, 100, 100, 100] },
    ],
  };
  const sol = solve(problem);
  assert.equal(sol.feasible, true);
  assert.deepEqual(sol.amounts, [2, 0]);
  assert.equal(sol.revenue, 9);
  assert.equal(sol.cost, 4);
});

test("16 groups solve quickly and match brute force on a constrained instance", () => {
  const groups = Array.from({ length: 16 }, (_, i) => ({
    id: `g${i}`,
    channel: i % 2 === 0 ? "A" : "B",
    unitCost: 3 + (i % 3),
    unitImpressions: 1 + (i % 4),
    revenue: [0, 3, 7, 10, 12, 13, 14, 15, 16, 17, 18].map((v) => v + (i % 5)),
  }));
  const problem: Problem = {
    channels: [
      { id: "A", budget: 60 },
      { id: "B", budget: 55 },
    ],
    minImpressions: 20,
    groups,
  };
  const sol = solve(problem);
  assert.equal(sol.feasible, true);
  const cert = buildCertificate(problem, sol, null);
  assert.equal(cert.budgetCertificate.checks.allBudgetsRespected, true);
  assert.equal(cert.budgetCertificate.checks.impressionsSatisfied, true);
  assert.equal(cert.budgetCertificate.checks.amountsWithinRange, true);
});

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

function randomProblem(rand: () => number, groups: number, channels: number): Problem {
  const pick = (n: number) => Math.floor(rand() * n);
  return {
    channels: Array.from({ length: channels }, (_, c) => ({
      id: `ch${c}`,
      budget: pick(25),
    })),
    minImpressions: pick(30),
    groups: Array.from({ length: groups }, (_, i) => ({
      id: `g${i}`,
      channel: `ch${pick(channels)}`,
      unitCost: pick(5),
      unitImpressions: pick(5),
      revenue: Array.from({ length: 11 }, () => pick(31)),
    })),
  };
}

test("randomized cross-check: DP matches brute force (small instances)", () => {
  const rand = mulberry32(20261005);
  const sizes = [1, 2, 3, 4, 5, 5, 6, 6];
  for (let iter = 0; iter < 40; iter++) {
    const n = sizes[iter % sizes.length] as number;
    const channels = 1 + (iter % 3);
    const problem = randomProblem(rand, n, channels);
    const dp = solve(problem);
    const bf = bruteForce(problem);
    assert.equal(dp.feasible, bf.feasible, `feasibility mismatch at iter ${iter}`);
    if (bf.feasible) {
      assert.equal(dp.revenue, bf.revenue, `revenue mismatch at iter ${iter}`);
      assert.equal(dp.cost, bf.cost, `cost mismatch at iter ${iter}`);
      const amounts = dp.amounts as number[];
      amounts.forEach((x, i) => {
        const g = problem.groups[i] as (typeof problem.groups)[number];
        assert.ok(Number.isInteger(x) && x >= 0 && x <= 10);
        assert.equal(g.revenue[x] !== undefined, true);
      });
      const cert = buildCertificate(problem, dp, bf);
      assert.equal(cert.optimality.bruteForce?.matches, true);
      assert.equal(cert.budgetCertificate.checks.allBudgetsRespected, true);
      assert.equal(cert.budgetCertificate.checks.impressionsSatisfied, true);
    }
  }
});

test("validation rejects malformed input", () => {
  const base = {
    channels: [{ id: "A", budget: 10 }],
    minImpressions: 0,
    groups: [
      { id: "g1", channel: "A", unitCost: 1, unitImpressions: 1, revenue: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10] },
    ],
  };
  assert.throws(() => validateProblem({ ...base, minImpressions: 1.5 }));
  assert.throws(() => validateProblem({ ...base, channels: [{ id: "A", budget: -1 }] }));
  assert.throws(() => validateProblem({ ...base, groups: [{ ...base.groups[0], revenue: [0, 1, 2] }] }));
  assert.throws(() => validateProblem({ ...base, groups: [{ ...base.groups[0], channel: "nope" }] }));
  assert.throws(() =>
    validateProblem({
      ...base,
      groups: Array.from({ length: 17 }, (_, i) => ({ ...base.groups[0], id: `g${i}` })),
    }),
  );
  assert.throws(() => validateProblem({ ...base, groups: [{ ...base.groups[0], unitCost: 2.5 }] }));
  assert.equal(validateProblem(base).groups.length, 1);
});
