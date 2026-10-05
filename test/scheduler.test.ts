import { test } from "node:test";
import assert from "node:assert/strict";
import { Instance, validateInstance, MAX_TICKS_LIMIT } from "../src/model";
import { solve } from "../src/solve";
import { bruteForceMakespan } from "../src/brute";
import { simulate } from "../src/simulate";

/** Deterministic PRNG (mulberry32) so tests are reproducible. */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function randomInstance(rand: () => number, n: number): Instance {
  const ri = (lo: number, hi: number) => lo + Math.floor(rand() * (hi - lo + 1));
  const coolRate = ri(1, 4);
  const heatCap = ri(6, 24);
  const tasks = Array.from({ length: n }, (_, i) => {
    const duration = ri(1, 5);
    const heat = ri(1, 8);
    // Mix of tight and loose deadlines; some instances end up infeasible.
    const deadline = ri(duration, MAX_TICKS_LIMIT);
    return { id: `t${i}`, duration, heat, deadline };
  });
  return { coolRate, heatCap, maxTicks: MAX_TICKS_LIMIT, tasks };
}

function checkAgreement(inst: Instance): void {
  validateInstance(inst);
  const sol = solve(inst);
  const bf = bruteForceMakespan(inst);
  if (bf === -1) {
    assert.equal(sol.feasible, false, "BFS says infeasible but solver found a schedule");
    return;
  }
  assert.equal(sol.feasible, true, "solver says infeasible but BFS found a schedule");
  assert.equal(sol.makespan, bf, "solver makespan != exhaustive BFS makespan");
  const sim = simulate(inst, sol.schedule);
  assert.deepEqual(sim.errors, [], "simulator rejected solver schedule");
  assert.equal(sim.makespan, sol.makespan);
  // Solver's own trace must match the simulator's independent replay.
  assert.deepEqual(sol.trace, sim.trace);
}

test("fixed sample instance: optimal makespan, valid trajectory", () => {
  const inst: Instance = {
    coolRate: 2,
    heatCap: 12,
    maxTicks: 50,
    tasks: [
      { id: "compile", duration: 3, heat: 4, deadline: 20 },
      { id: "link", duration: 2, heat: 5, deadline: 30 },
      { id: "unit-test", duration: 4, heat: 3, deadline: 40 },
      { id: "lint", duration: 1, heat: 2, deadline: 10 },
      { id: "package", duration: 2, heat: 6, deadline: 45 },
      { id: "deploy", duration: 3, heat: 4, deadline: 50 },
    ],
  };
  checkAgreement(inst);
  const sol = solve(inst);
  // Sum of durations is 15, but the heat cap forces cooling idles; both
  // independent solvers agree the optimum is 39.
  assert.equal(sol.makespan, 39);
  assert.ok(sol.trace.every((tr) => tr.heatAfter <= inst.heatCap));
});

test("heat cap forces idle cooling ticks", () => {
  const inst: Instance = {
    coolRate: 1,
    heatCap: 5,
    maxTicks: 50,
    tasks: [
      { id: "a", duration: 2, heat: 2, deadline: 50 },
      { id: "b", duration: 2, heat: 2, deadline: 50 },
    ],
  };
  checkAgreement(inst);
  const sol = solve(inst);
  // a ends at heat 4; b needs heat <= 1 to start (1+2+2=5 <= cap), so 3 idle
  // cooling ticks are forced: makespan = 2 + 3 + 2 = 7.
  assert.equal(sol.makespan, 7);
  assert.ok(sol.trace.some((tr) => tr.action === "idle"));
});

test("deadline miss makes instance infeasible", () => {
  const inst: Instance = {
    coolRate: 2,
    heatCap: 30,
    maxTicks: 50,
    tasks: [
      { id: "a", duration: 4, heat: 1, deadline: 3 }, // can never finish by tick 3
      { id: "b", duration: 2, heat: 1, deadline: 50 },
    ],
  };
  checkAgreement(inst);
  assert.equal(solve(inst).feasible, false);
});

test("heat cap makes back-to-back runs impossible and horizon too short", () => {
  const inst: Instance = {
    coolRate: 1,
    heatCap: 3,
    maxTicks: 6,
    tasks: [
      { id: "a", duration: 3, heat: 3, deadline: 6 },
      { id: "b", duration: 3, heat: 3, deadline: 6 },
    ],
  };
  checkAgreement(inst);
  assert.equal(solve(inst).feasible, false);
});

test("single task, zero heat, immediate completion", () => {
  const inst: Instance = {
    coolRate: 1,
    heatCap: 0,
    maxTicks: 50,
    tasks: [{ id: "x", duration: 2, heat: 0, deadline: 50 }],
  };
  checkAgreement(inst);
  assert.equal(solve(inst).makespan, 2);
});

test("random instances: solver agrees with exhaustive per-tick BFS", () => {
  const rand = rng(20261005);
  for (let k = 0; k < 120; k++) {
    const n = 1 + Math.floor(rand() * 8); // 1..8 tasks
    checkAgreement(randomInstance(rand, n));
  }
});

test("random larger instances (up to 14 tasks)", () => {
  const rand = rng(777);
  for (let k = 0; k < 12; k++) {
    const n = 9 + Math.floor(rand() * 6); // 9..14 tasks
    checkAgreement(randomInstance(rand, n));
  }
});

test("input validation rejects bad instances", () => {
  const base: Instance = {
    coolRate: 1,
    heatCap: 5,
    maxTicks: 50,
    tasks: [{ id: "a", duration: 1, heat: 1, deadline: 5 }],
  };
  assert.throws(() => validateInstance({ ...base, maxTicks: 51 }));
  assert.throws(() => validateInstance({ ...base, coolRate: -1 }));
  assert.throws(() => validateInstance({ ...base, tasks: [] }));
  assert.throws(() =>
    validateInstance({
      ...base,
      tasks: Array.from({ length: 15 }, (_, i) => ({
        id: `t${i}`,
        duration: 1,
        heat: 1,
        deadline: 5,
      })),
    }),
  );
  assert.throws(() =>
    validateInstance({
      ...base,
      tasks: [
        { id: "a", duration: 1, heat: 1, deadline: 5 },
        { id: "a", duration: 1, heat: 1, deadline: 5 },
      ],
    }),
  );
});
