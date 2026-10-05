import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { parseProblem, solve } from "../src/solver.js";
import { verify } from "../src/verifier.js";
import type { OptimalResult } from "../src/types.js";

const problem = parseProblem(JSON.parse(readFileSync("examples/feasible.json", "utf8")));
const solved = solve(problem);
if (solved.status !== "optimal") throw new Error("example must be feasible");
const optimal: OptimalResult = solved;

test("verifier accepts the genuine certificate", () => {
  assert.ok(verify(problem, optimal).ok);
});

test("verifier rejects a non-permutation matching", () => {
  const bad: OptimalResult = { ...optimal, matching: optimal.matching.map(() => 0) };
  const check = verify(problem, bad);
  assert.ok(!check.ok);
  assert.ok(check.errors.some((e) => e.includes("more than once")));
});

test("verifier rejects a matching using a forbidden edge", () => {
  const matching = [...optimal.matching];
  matching[0] = 1; // costs[0][1] is null (forbidden) in the example
  const bad: OptimalResult = { ...optimal, matching };
  const check = verify(problem, bad);
  assert.ok(!check.ok);
  assert.ok(check.errors.some((e) => e.includes("forbidden")));
});

test("verifier rejects a misreported cost", () => {
  const bad: OptimalResult = { ...optimal, cost: optimal.cost - 1 };
  assert.ok(!verify(problem, bad).ok);
});

test("verifier rejects tampered duals", () => {
  const u = [...optimal.dual.u];
  u[0] = u[0]! + 10;
  const bad: OptimalResult = { ...optimal, dual: { u, v: [...optimal.dual.v] } };
  assert.ok(!verify(problem, bad).ok);
});

test("verifier rejects a fabricated Hall witness", () => {
  const infeasible = parseProblem(JSON.parse(readFileSync("examples/infeasible.json", "utf8")));
  // Rows {0} alone have 1 neighbor, so |N(S)| >= |S|: not a violation.
  assert.ok(!verify(infeasible, { status: "infeasible", hall: { rows: [0], neighbors: [0] } }).ok);
  // Wrong neighbor set for a real violating row set.
  assert.ok(!verify(infeasible, { status: "infeasible", hall: { rows: [0, 1], neighbors: [0, 2] } }).ok);
  // Empty witness.
  assert.ok(!verify(infeasible, { status: "infeasible", hall: { rows: [], neighbors: [] } }).ok);
});
