import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { parseProblem, solve } from "../src/solver.js";
import { verify } from "../src/verifier.js";
import { bruteForce } from "../src/bruteforce.js";
import type { Problem } from "../src/types.js";

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function randomProblem(rand: () => number, n: number, forbidProb: number): Problem {
  return {
    orders: Array.from({ length: n }, (_, i) => `W${i + 1}`),
    stations: Array.from({ length: n }, (_, j) => `S${j + 1}`),
    costs: Array.from({ length: n }, () =>
      Array.from({ length: n }, () =>
        rand() < forbidProb ? null : Math.floor(rand() * 41) - 20,
      ),
    ),
  };
}

test("fixed example with negative costs and forbidden edges is optimal and verified", () => {
  const problem = parseProblem(JSON.parse(readFileSync("examples/feasible.json", "utf8")));
  const result = solve(problem);
  assert.equal(result.status, "optimal");
  const check = verify(problem, result);
  assert.deepEqual(check.errors, []);
  assert.ok(check.ok);
  const bf = bruteForce(problem);
  assert.ok(bf.feasible);
  assert.equal(result.status === "optimal" ? result.cost : NaN, bf.cost);
  // Every matched edge must be allowed.
  if (result.status === "optimal") {
    result.matching.forEach((j, i) => assert.notEqual(problem.costs[i]![j], null));
  }
});

test("infeasible example yields a valid Hall witness", () => {
  const problem = parseProblem(JSON.parse(readFileSync("examples/infeasible.json", "utf8")));
  const result = solve(problem);
  assert.equal(result.status, "infeasible");
  if (result.status !== "infeasible") return;
  assert.deepEqual(result.hall.rows, [0, 1]);
  assert.deepEqual(result.hall.neighbors, [0]);
  const check = verify(problem, result);
  assert.deepEqual(check.errors, []);
});

test("all-negative matrix picks the most negative permutation", () => {
  const problem: Problem = {
    orders: ["A", "B"],
    stations: ["X", "Y"],
    costs: [
      [-5, -1],
      [-2, -9],
    ],
  };
  const result = solve(problem);
  assert.equal(result.status, "optimal");
  if (result.status !== "optimal") return;
  assert.equal(result.cost, -14); // A->X (-5) + B->Y (-9)
  assert.ok(verify(problem, result).ok);
});

test("randomized cross-check: solver vs permutation enumeration", () => {
  const rand = mulberry32(20261005);
  for (let trial = 0; trial < 300; trial++) {
    const n = 1 + Math.floor(rand() * 8); // 1..8
    const problem = randomProblem(rand, n, 0.25);
    const result = solve(problem);
    const check = verify(problem, result);
    assert.ok(check.ok, `verification failed on trial ${trial}: ${check.errors.join("; ")}`);
    const bf = bruteForce(problem);
    if (result.status === "optimal") {
      assert.ok(bf.feasible, `solver feasible but brute force infeasible on trial ${trial}`);
      assert.equal(result.cost, bf.cost, `cost mismatch on trial ${trial}`);
    } else {
      assert.ok(!bf.feasible, `solver infeasible but brute force found ${bf.cost} on trial ${trial}`);
    }
  }
});

test("input validation rejects malformed problems", () => {
  assert.throws(() => parseProblem({ orders: ["A"], stations: [], costs: [[]] }), /equal/);
  assert.throws(() => parseProblem({ orders: ["A", "A"], stations: ["X", "Y"], costs: [[1, 2], [3, 4]] }), /duplicate/);
  assert.throws(() => parseProblem({ orders: ["A"], stations: ["X"], costs: [[NaN]] }), /finite/);
  assert.throws(() => parseProblem({ orders: ["A"], stations: ["X"], costs: [[1, 2]] }), /length 1/);
  const tooMany = Array.from({ length: 13 }, (_, i) => `W${i}`);
  assert.throws(() => parseProblem({ orders: tooMany, stations: tooMany, costs: tooMany.map(() => tooMany.map(() => 1)) }), /1\.\.12/);
});
