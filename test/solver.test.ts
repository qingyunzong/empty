import { test } from "node:test";
import assert from "node:assert";
import { execFileSync } from "node:child_process";
import { solve, type Problem } from "../src/solver.js";
import { verifySolution } from "../src/verify.js";
import { bruteForcePermutation, dpSolve } from "../src/brute.js";
import { parseProblem } from "../src/parse.js";

function makeProblem(n: number, cost: number[][], forbidden: [number, number][] = []): Problem {
  const allowed = Array.from({ length: n }, () => new Array<boolean>(n).fill(true));
  for (const [i, j] of forbidden) allowed[i][j] = false;
  return {
    orderIds: Array.from({ length: n }, (_, i) => `W${i + 1}`),
    stationIds: Array.from({ length: n }, (_, j) => `S${j + 1}`),
    cost,
    allowed,
  };
}

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

function randomProblem(rand: () => number, n: number, pForbidden: number): Problem {
  const cost = Array.from({ length: n }, () =>
    Array.from({ length: n }, () => Math.floor(rand() * 61) - 30)
  );
  const forbidden: [number, number][] = [];
  for (let i = 0; i < n; i++)
    for (let j = 0; j < n; j++) if (rand() < pForbidden) forbidden.push([i, j]);
  return makeProblem(n, cost, forbidden);
}

function assertConsistent(problem: Problem): void {
  const result = solve(problem);
  const report = verifySolution(problem, result);
  assert.ok(report.ok, `verifier rejected: ${report.errors.join("; ")}`);
  const dp = dpSolve(problem);
  assert.strictEqual(result.status === "optimal", dp.feasible, "feasibility disagrees with DP");
  if (result.status === "optimal") {
    assert.ok(Math.abs(result.cost - dp.cost) < 1e-9, `cost ${result.cost} != DP ${dp.cost}`);
  }
}

test("handcrafted: negative costs, known optimum", () => {
  const problem = makeProblem(3, [
    [-5, 2, 1],
    [3, -4, 0],
    [1, 2, -3],
  ]);
  const result = solve(problem);
  assert.strictEqual(result.status, "optimal");
  if (result.status === "optimal") {
    assert.strictEqual(result.cost, -12); // W1->S1, W2->S2, W3->S3
    assert.deepStrictEqual(result.match, [0, 1, 2]);
  }
  assert.ok(verifySolution(problem, result).ok);
});

test("handcrafted: forbidden forces detour", () => {
  const problem = makeProblem(2, [[1, 100], [1, 1]], [[0, 0], [1, 1]]);
  const result = solve(problem);
  assert.strictEqual(result.status, "optimal");
  if (result.status === "optimal") {
    assert.strictEqual(result.cost, 101); // W1->S2(100) + W2->S1(1)
    assert.deepStrictEqual(result.match, [1, 0]);
  }
  assert.ok(verifySolution(problem, result).ok);
});

test("handcrafted: infeasible with Hall witness", () => {
  // 三个工单都只能去 S1、S2：S={W1,W2,W3}, N(S)={S1,S2}, 3 > 2。
  const problem = makeProblem(
    3,
    [
      [1, 2, 9],
      [3, 4, 9],
      [5, 6, 7],
    ],
    [[0, 2], [1, 2], [2, 2]]
  );
  const result = solve(problem);
  assert.strictEqual(result.status, "infeasible");
  if (result.status === "infeasible") {
    const { orders, neighborhood } = result.hallWitness;
    assert.ok(orders.length > neighborhood.length);
  }
  assert.ok(verifySolution(problem, result).ok);
});

test("handcrafted: fully forbidden", () => {
  const n = 4;
  const forbidden: [number, number][] = [];
  for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) forbidden.push([i, j]);
  const problem = makeProblem(n, Array.from({ length: n }, () => new Array(n).fill(1)), forbidden);
  const result = solve(problem);
  assert.strictEqual(result.status, "infeasible");
  assert.ok(verifySolution(problem, result).ok);
});

test("handcrafted: n = 1", () => {
  const ok = makeProblem(1, [[-7]]);
  const r1 = solve(ok);
  assert.strictEqual(r1.status, "optimal");
  if (r1.status === "optimal") assert.strictEqual(r1.cost, -7);
  assert.ok(verifySolution(ok, r1).ok);

  const bad = makeProblem(1, [[-7]], [[0, 0]]);
  const r2 = solve(bad);
  assert.strictEqual(r2.status, "infeasible");
  assert.ok(verifySolution(bad, r2).ok);
});

test("randomized: solver vs permutation enumeration + DP, n <= 8", () => {
  const rand = mulberry32(20261005);
  for (let iter = 0; iter < 300; iter++) {
    const n = 1 + Math.floor(rand() * 8);
    const pForbidden = [0, 0.15, 0.35, 0.6][iter % 4];
    const problem = randomProblem(rand, n, pForbidden);
    const result = solve(problem);
    const report = verifySolution(problem, result);
    assert.ok(report.ok, `iter ${iter}: verifier: ${report.errors.join("; ")}`);
    const bf = bruteForcePermutation(problem);
    assert.strictEqual(result.status === "optimal", bf.feasible, `iter ${iter}: feasibility vs brute force`);
    if (result.status === "optimal") {
      assert.ok(
        Math.abs(result.cost - bf.cost) < 1e-9,
        `iter ${iter}: cost ${result.cost} != brute force ${bf.cost}`
      );
    }
    assertConsistent(problem);
  }
});

test("randomized: n = 12 vs DP cross-check", () => {
  const rand = mulberry32(123456789);
  for (let iter = 0; iter < 40; iter++) {
    const pForbidden = [0, 0.1, 0.3, 0.5][iter % 4];
    const problem = randomProblem(rand, 12, pForbidden);
    assertConsistent(problem);
  }
});

test("randomized: all-negative costs, n = 12", () => {
  const rand = mulberry32(42);
  for (let iter = 0; iter < 10; iter++) {
    const n = 12;
    const cost = Array.from({ length: n }, () =>
      Array.from({ length: n }, () => -(Math.floor(rand() * 1000) + 1))
    );
    assertConsistent(makeProblem(n, cost));
  }
});

test("CLI end-to-end on examples", (t) => {
  const cli = new URL("../src/cli.js", import.meta.url).pathname;
  const feasible = new URL("../../examples/feasible.json", import.meta.url).pathname;
  const infeasible = new URL("../../examples/infeasible.json", import.meta.url).pathname;

  let out1: any;
  try {
    out1 = JSON.parse(execFileSync(process.argv[0], [cli, feasible, "--check", "--brute"], { encoding: "utf8" }));
  } catch (err: any) {
    if (err?.code === "EPERM") return t.skip("sandbox blocks child processes");
    throw err;
  }
  assert.strictEqual(out1.status, "optimal");
  assert.strictEqual(out1.cost, -2);
  assert.ok(out1.verification.ok);
  assert.strictEqual(out1.crossCheck.dpAgrees, true);
  assert.strictEqual(out1.crossCheck.bruteForce.cost, -2);
  assert.strictEqual(out1.matching.length, 4);

  let out2: any;
  try {
    execFileSync(process.argv[0], [cli, infeasible], { encoding: "utf8", stdio: "pipe" });
    assert.fail("infeasible run should exit with code 3");
  } catch (err: any) {
    assert.strictEqual(err.status, 3);
    out2 = JSON.parse(err.stdout);
  }
  assert.strictEqual(out2.status, "infeasible");
  assert.ok(out2.verification.ok);
  assert.deepStrictEqual(out2.hallWitness.orders.sort(), ["A", "B", "C"]);
  assert.deepStrictEqual(out2.hallWitness.neighborhood.sort(), ["W", "X"]);
});

test("input validation", () => {
  assert.throws(() => parseProblem({ orders: ["A"], stations: ["A", "B"], costMatrix: [[1]] }));
  assert.throws(() => parseProblem({ orders: ["A"], stations: ["A"] }));
  assert.throws(() =>
    parseProblem({ orders: ["A"], stations: ["A"], costMatrix: [[1]], forbidden: [["A", "X"]] })
  );
  const thirteen = Array.from({ length: 13 }, (_, i) => `W${i}`);
  assert.throws(() =>
    parseProblem({ orders: thirteen, stations: thirteen, costMatrix: Array.from({ length: 13 }, () => new Array(13).fill(0)) })
  );
});
