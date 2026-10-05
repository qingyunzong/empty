import { test } from "node:test";
import { equal, ok } from "node:assert/strict";
import { parseExpr } from "../src/expr.js";
import { solve, type NamedConstraint } from "../src/solver.js";
import { hashConstraints, type StoredResult } from "../src/state.js";
import { verifyResult } from "../src/verify.js";

function cs(entries: [string, string][]): NamedConstraint[] {
  return entries.map(([name, text]) => ({ name, exprText: text, expr: parseExpr(text) }));
}

function toStored(constraints: NamedConstraint[], result: ReturnType<typeof solve>): StoredResult {
  const record = Object.fromEntries(constraints.map((c) => [c.name, c.exprText]));
  if (result.status === "paused") throw new Error("unexpected pause");
  const stored: StoredResult = {
    status: result.status,
    inputHash: hashConstraints(record),
    constraints: record,
    stats: {
      totalSteps: result.stats.totalSteps,
      smallerSubsetsChecked: result.stats.smallerSubsetsChecked,
      cacheHit: result.stats.cacheHit,
    },
  };
  if (result.status === "sat") {
    stored.assignment = result.assignment;
    stored.assignmentIndex = result.assignmentIndex;
  } else {
    stored.core = result.core;
    stored.proof = result.proof;
    stored.proofTree = result.proofTree;
  }
  return stored;
}

const UNSAT_INPUT: [string, string][] = [
  ["c1", "a"],
  ["c2", "a"],
  ["c3", "!a"],
  ["c4", "b | !b"],
];

test("verify: a genuine UNSAT result passes every independent check", () => {
  const constraints = cs(UNSAT_INPUT);
  const stored = toStored(constraints, solve(constraints));
  const checks = verifyResult(constraints, stored, [{ sources: ["c1", "c3"] }]);
  for (const check of checks) ok(check.ok, `${check.name}: ${check.detail}`);
  const minimality = checks.find((c) => c.name === "minimality-all-smaller-subsets-sat")!;
  ok(minimality.detail.includes("4 subsets"), minimality.detail); // C(4,1) = 4
});

test("verify: a genuine SAT result passes every independent check", () => {
  const constraints = cs([
    ["c1", "a | b"],
    ["c2", "!a | c"],
  ]);
  const stored = toStored(constraints, solve(constraints));
  const checks = verifyResult(constraints, stored, []);
  for (const check of checks) ok(check.ok, `${check.name}: ${check.detail}`);
});

test("verify: a non-minimal core is caught by the smaller-subset audit", () => {
  const constraints = cs(UNSAT_INPUT);
  const stored = toStored(constraints, solve(constraints));
  stored.core = ["c1", "c2", "c3"]; // not minimal: {c1, c3} is smaller
  const checks = verifyResult(constraints, stored, []);
  const minimality = checks.find((c) => c.name === "minimality-all-smaller-subsets-sat")!;
  equal(minimality.ok, false);
  ok(minimality.detail.includes("c1, c3"), minimality.detail);
});

test("verify: a satisfiable 'core' is caught by the truth-table check", () => {
  const constraints = cs(UNSAT_INPUT);
  const stored = toStored(constraints, solve(constraints));
  stored.core = ["c1", "c2"]; // satisfiable together
  const checks = verifyResult(constraints, stored, []);
  const truthTable = checks.find((c) => c.name === "core-unsat-truth-table")!;
  equal(truthTable.ok, false);
});

test("verify: a tampered assignment is caught", () => {
  const constraints = cs([
    ["c1", "a | b"],
    ["c2", "!a | c"],
  ]);
  const stored = toStored(constraints, solve(constraints));
  stored.assignment = { a: false, b: false, c: false }; // falsifies c1
  const checks = verifyResult(constraints, stored, []);
  equal(checks.find((c) => c.name === "assignment-satisfies-all")!.ok, false);
});

test("verify: a non-minimal satisfying assignment is caught", () => {
  const constraints = cs([
    ["c1", "a | b"],
    ["c2", "!a | c"],
  ]);
  const stored = toStored(constraints, solve(constraints));
  stored.assignment = { a: true, b: false, c: true }; // satisfies, but not lex-min
  stored.assignmentIndex = 5;
  const checks = verifyResult(constraints, stored, []);
  equal(checks.find((c) => c.name === "assignment-satisfies-all")!.ok, true);
  equal(checks.find((c) => c.name === "assignment-lexicographically-minimal")!.ok, false);
});

test("verify: cache audit flags corrupt entries and tolerates non-reusable ones", () => {
  const constraints = cs(UNSAT_INPUT);
  const stored = toStored(constraints, solve(constraints));
  // Entry with a missing source: allowed, simply not reusable right now.
  const afterRetraction = verifyResult(constraints, stored, [{ sources: ["c1", "h9"] }]);
  const tolerant = afterRetraction.find((c) => c.name === "conflict-cache-sound")!;
  ok(tolerant.ok, tolerant.detail);
  ok(tolerant.detail.includes("not reusable"), tolerant.detail);
  // Entry whose sources are all present but actually satisfiable: corrupt.
  const corrupt = verifyResult(constraints, stored, [{ sources: ["c1", "c2"] }]);
  equal(corrupt.find((c) => c.name === "conflict-cache-sound")!.ok, false);
});
