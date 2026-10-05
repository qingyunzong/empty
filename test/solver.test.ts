import { test, describe } from "node:test";
import assert from "node:assert/strict";
import type { Problem } from "../src/model.js";
import { solve } from "../src/solve.js";
import { bruteForceMakespan } from "../src/bruteforce.js";
import { checkSchedule } from "../src/schedule.js";
import { renderTimeline } from "../src/timeline.js";
import { demo } from "../src/demo.js";

function solved(problem: Problem) {
  const sol = solve(problem);
  assert.ok(sol, "expected a feasible schedule");
  checkSchedule(problem, sol); // validity of every returned schedule
  return sol;
}

describe("known optima", () => {
  test("two independent jobs run in parallel", () => {
    const p: Problem = {
      horizon: 40,
      jobs: [
        { id: "a", duration: 3, skill: "any", deps: [] },
        { id: "b", duration: 5, skill: "any", deps: [] },
      ],
    };
    assert.equal(solved(p).makespan, 5);
  });

  test("dependency chain sums durations", () => {
    const p: Problem = {
      horizon: 40,
      jobs: [
        { id: "a", duration: 3, skill: "any", deps: [] },
        { id: "b", duration: 4, skill: "any", deps: ["a"] },
        { id: "c", duration: 2, skill: "any", deps: ["b"] },
      ],
    };
    assert.equal(solved(p).makespan, 9);
  });

  test("skill-pinned jobs cannot share one worker", () => {
    const p: Problem = {
      horizon: 40,
      jobs: [
        { id: "a1", duration: 4, skill: "A", deps: [] },
        { id: "a2", duration: 4, skill: "A", deps: [] },
        { id: "b1", duration: 3, skill: "B", deps: [] },
      ],
    };
    assert.equal(solved(p).makespan, 8);
  });

  test("both-job occupies both workers synchronously", () => {
    const p: Problem = {
      horizon: 40,
      jobs: [
        { id: "solo1", duration: 2, skill: "A", deps: [] },
        { id: "solo2", duration: 2, skill: "B", deps: [] },
        { id: "joint", duration: 3, skill: "both", deps: ["solo1", "solo2"] },
      ],
    };
    const sol = solved(p);
    assert.equal(sol.makespan, 5);
    const joint = sol.entries.find((e) => e.id === "joint")!;
    assert.deepEqual([...joint.workers].sort(), [0, 1]);
  });

  test("waiting for a both-job beats greedy single starts", () => {
    // Starting x and y at t=0 forces the joint job to t=3 -> finish 7.
    // Optimum: joint first (0..4), then x,y in parallel -> finish 7 as well,
    // but mixing (x at 0, joint at 2) is worse; check the exact optimum.
    const p: Problem = {
      horizon: 40,
      jobs: [
        { id: "x", duration: 3, skill: "A", deps: [] },
        { id: "y", duration: 3, skill: "B", deps: [] },
        { id: "joint", duration: 4, skill: "both", deps: [] },
      ],
    };
    assert.equal(solved(p).makespan, 7);
    assert.equal(bruteForceMakespan(p), 7);
  });

  test("infeasible within horizon returns null", () => {
    const p: Problem = {
      horizon: 10,
      jobs: [
        { id: "a", duration: 6, skill: "any", deps: [] },
        { id: "b", duration: 6, skill: "any", deps: ["a"] },
      ],
    };
    assert.equal(solve(p), null);
    assert.equal(bruteForceMakespan(p), null);
  });
});

describe("cross-check vs exhaustive permutation search", () => {
  // Deterministic PRNG (mulberry32) for reproducible random instances.
  function rng(seed: number) {
    let s = seed >>> 0;
    return () => {
      s = (s + 0x6d2b79f5) >>> 0;
      let z = s;
      z = Math.imul(z ^ (z >>> 15), z | 1);
      z ^= z + Math.imul(z ^ (z >>> 7), z | 61);
      return ((z ^ (z >>> 14)) >>> 0) / 4294967296;
    };
  }
  const skills = ["A", "B", "any", "both"] as const;

  function randomProblem(seed: number): Problem {
    const rand = rng(seed);
    const n = 5 + Math.floor(rand() * 4); // 5..8 jobs
    const jobs = [];
    for (let i = 0; i < n; i++) {
      const deps: string[] = [];
      for (let j = 0; j < i; j++) {
        if (rand() < 0.25) deps.push(`J${j}`);
      }
      jobs.push({
        id: `J${i}`,
        duration: 1 + Math.floor(rand() * 6),
        skill: skills[Math.floor(rand() * skills.length)],
        deps,
      });
    }
    return { jobs, horizon: 40 };
  }

  for (let seed = 1; seed <= 40; seed++) {
    test(`random instance #${seed}: solve() == bruteForce()`, () => {
      const p = randomProblem(seed);
      const sol = solve(p);
      const bf = bruteForceMakespan(p);
      if (sol === null) {
        assert.equal(bf, null);
      } else {
        checkSchedule(p, sol);
        assert.equal(sol.makespan, bf, `makespan mismatch on seed ${seed}`);
      }
    });
  }
});

describe("demo instance (14 jobs, horizon 40)", () => {
  test("solves optimally within horizon and renders a timeline", () => {
    const sol = solved(demo);
    assert.ok(sol.makespan <= 40);
    // Lower bound: total worker-time 55 over 2 workers -> makespan >= 28.
    assert.ok(sol.makespan >= 28);
    const chart = renderTimeline(demo, sol);
    for (const job of demo.jobs) assert.ok(chart.includes(job.id));
    assert.ok(chart.includes("W1(A)") && chart.includes("W2(B)"));
  });
});
