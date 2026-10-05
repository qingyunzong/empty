import { test, describe } from "node:test";
import * as assert from "node:assert/strict";
import { parseProblem, validateProblem, type Problem } from "../src/model.js";
import { solve } from "../src/solver.js";
import { verifyExhaustive } from "../src/verifier.js";
import { simulate } from "../src/simulate.js";

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function randInt(rnd: () => number, lo: number, hi: number): number {
  return lo + Math.floor(rnd() * (hi - lo + 1));
}

function randomProblem(rnd: () => number): Problem {
  const n = randInt(rnd, 1, 8);
  const maxTemp = randInt(rnd, 4, 16);
  const tasks = Array.from({ length: n }, (_, i) => {
    const duration = randInt(rnd, 1, 4);
    return {
      id: `t${i}`,
      duration,
      heat: randInt(rnd, 0, 6),
      deadline: randInt(rnd, duration, 30),
    };
  });
  return {
    maxTemp,
    coolingRate: randInt(rnd, 0, 4),
    initialTemp: randInt(rnd, 0, Math.floor(maxTemp / 2)),
    maxTicks: 50,
    tasks,
  };
}

describe("hand-computed instances", () => {
  const problem: Problem = {
    maxTemp: 12,
    coolingRate: 3,
    initialTemp: 0,
    maxTicks: 50,
    tasks: [
      { id: "A", duration: 2, heat: 4, deadline: 8 },
      { id: "B", duration: 2, heat: 5, deadline: 12 },
    ],
  };

  test("finds the known optimum of 6 ticks", () => {
    const r = solve(problem);
    assert.equal(r.feasible, true);
    assert.equal(r.makespan, 6);
  });

  test("exhaustive verifier agrees on the optimum", () => {
    const v = verifyExhaustive(problem);
    assert.equal(v.feasible, true);
    assert.equal(v.makespan, 6);
  });

  test("returned trajectory passes tick-by-tick validation", () => {
    const r = solve(problem);
    const sim = simulate(problem, r.runs);
    assert.deepEqual(sim.errors, []);
    assert.equal(sim.ok, true);
    assert.equal(sim.temps.length, 6);
    for (const t of sim.temps) assert.ok(t <= problem.maxTemp);
  });
});

describe("infeasible instances", () => {
  test("task hotter than maxTemp can never run", () => {
    const p: Problem = {
      maxTemp: 4, coolingRate: 2, initialTemp: 0, maxTicks: 50,
      tasks: [{ id: "hot", duration: 1, heat: 5, deadline: 50 }],
    };
    assert.equal(solve(p).feasible, false);
    assert.equal(verifyExhaustive(p).feasible, false);
  });

  test("deadline earlier than duration is infeasible", () => {
    const p: Problem = {
      maxTemp: 100, coolingRate: 1, initialTemp: 0, maxTicks: 50,
      tasks: [{ id: "late", duration: 5, heat: 1, deadline: 3 }],
    };
    assert.equal(solve(p).feasible, false);
    assert.equal(verifyExhaustive(p).feasible, false);
  });

  test("horizon too short is infeasible", () => {
    const p: Problem = {
      maxTemp: 100, coolingRate: 1, initialTemp: 0, maxTicks: 50,
      tasks: [{ id: "long", duration: 51, heat: 0, deadline: 50 }],
    };
    // deadline 51 would exceed maxTicks and is rejected by validation;
    // with deadline 50 the task simply cannot fit.
    assert.equal(solve(p).feasible, false);
  });
});

describe("cooling forces idle ticks", () => {
  test("back-to-back execution overheats, optimum includes cooling", () => {
    const p: Problem = {
      maxTemp: 10, coolingRate: 2, initialTemp: 0, maxTicks: 50,
      tasks: [
        { id: "x", duration: 2, heat: 4, deadline: 20 },
        { id: "y", duration: 2, heat: 4, deadline: 20 },
      ],
    };
    const r = solve(p);
    // Back to back overheats (4,8,12). After x the temp is 8 and must cool
    // to 2 before y can run (2+4+4=10<=10), needing 3 idle ticks: 2+3+2=7.
    assert.equal(r.makespan, 7);
    const sim = simulate(p, r.runs);
    assert.ok(sim.ok, sim.errors.join("; "));
    const v = verifyExhaustive(p);
    assert.equal(v.makespan, r.makespan);
  });
});

describe("randomized cross-check: solver vs exhaustive verifier", () => {
  const rnd = mulberry32(20261005);
  const cases = 200;
  for (let c = 0; c < cases; c++) {
    const p = randomProblem(rnd);
    test(`random instance #${c} (${p.tasks.length} tasks)`, () => {
      const r = solve(p);
      const v = verifyExhaustive(p);
      assert.equal(r.feasible, v.feasible, "feasibility mismatch");
      assert.equal(r.makespan, v.makespan, "makespan mismatch");
      if (r.feasible) {
        const total = p.tasks.reduce((s, t) => s + t.duration, 0);
        assert.ok(r.makespan >= total, "makespan below total work");
        const sim = simulate(p, r.runs);
        assert.deepEqual(sim.errors, []);
      }
    });
  }
});

describe("14-task limit", () => {
  test("solves a 14-task instance and validates the trajectory", () => {
    const tasks = Array.from({ length: 14 }, (_, i) => ({
      id: `j${i}`, duration: 2, heat: 1, deadline: 50,
    }));
    const p: Problem = {
      maxTemp: 100, coolingRate: 1, initialTemp: 0, maxTicks: 50,
      tasks,
    };
    const r = solve(p);
    assert.equal(r.feasible, true);
    assert.equal(r.makespan, 28); // 14 tasks x 2 ticks, no cooling needed
    const sim = simulate(p, r.runs);
    assert.deepEqual(sim.errors, []);
  });

  test("rejects more than 14 tasks", () => {
    const tasks = Array.from({ length: 15 }, (_, i) => ({
      id: `j${i}`, duration: 1, heat: 1, deadline: 50,
    }));
    const p: Problem = {
      maxTemp: 10, coolingRate: 1, initialTemp: 0, maxTicks: 50,
      tasks,
    };
    assert.throws(() => validateProblem(p), /at most 14/);
  });
});

describe("input validation", () => {
  test("rejects maxTicks above 50", () => {
    const json = JSON.stringify({
      maxTemp: 10, coolingRate: 1, maxTicks: 51,
      tasks: [{ id: "a", duration: 1, heat: 1, deadline: 10 }],
    });
    assert.throws(() => parseProblem(json), /maxTicks/);
  });

  test("rejects duplicate task ids", () => {
    const json = JSON.stringify({
      maxTemp: 10, coolingRate: 1,
      tasks: [
        { id: "a", duration: 1, heat: 1, deadline: 10 },
        { id: "a", duration: 1, heat: 1, deadline: 10 },
      ],
    });
    assert.throws(() => parseProblem(json), /unique/);
  });
});
