import { test } from "node:test";
import { equal, deepEqual, ok, throws } from "node:assert/strict";
import { parseExpr } from "../src/expr.js";
import {
  LimitError,
  MAX_CONSTRAINTS,
  solve,
  type Frontier,
  type NamedConstraint,
  type SolveResult,
} from "../src/solver.js";
import { countLeaves, validateProofTree } from "../src/proof.js";

function cs(entries: [string, string][]): NamedConstraint[] {
  return entries.map(([name, text]) => ({ name, exprText: text, expr: parseExpr(text) }));
}

test("SAT: returns the lexicographically smallest assignment (false < true, variables sorted)", () => {
  const result = solve(cs([
    ["c1", "a | b"],
    ["c2", "!a | c"],
  ]));
  equal(result.status, "sat");
  if (result.status !== "sat") return;
  deepEqual(result.assignment, { a: false, b: true, c: false });
  equal(result.assignmentIndex, 2); // binary 010 in (a, b, c) order
});

test("SAT: tautological set assigns everything false", () => {
  const result = solve(cs([["c1", "a | !a"]]));
  equal(result.status, "sat");
  if (result.status === "sat") deepEqual(result.assignment, { a: false });
});

test("UNSAT: single self-contradictory constraint is a size-1 core", () => {
  const result = solve(cs([
    ["c1", "a & !a"],
    ["c2", "b"],
  ]));
  equal(result.status, "unsat");
  if (result.status !== "unsat") return;
  deepEqual(result.core, ["c1"]);
  equal(result.stats.smallerSubsetsChecked, 0);
});

test("UNSAT: minimum cardinality wins over lexicographic order", () => {
  // {x, y} is lexicographically smaller than {z}, but {z} is smaller.
  const result = solve(cs([
    ["x", "a"],
    ["y", "!a"],
    ["z", "b & !b"],
  ]));
  equal(result.status, "unsat");
  if (result.status === "unsat") deepEqual(result.core, ["z"]);
});

test("UNSAT: ties on cardinality are broken by the lexicographically smaller ID list", () => {
  const result = solve(cs([
    ["c1", "a"],
    ["c2", "a"],
    ["c3", "!a"],
  ]));
  equal(result.status, "unsat");
  if (result.status !== "unsat") return;
  deepEqual(result.core, ["c1", "c3"]); // not ["c2", "c3"]
  equal(result.stats.smallerSubsetsChecked, 3); // all three size-1 subsets are satisfiable
});

test("UNSAT: proof tree is a complete, genuinely contradictory case split", () => {
  const constraints = cs([
    ["c1", "a | b"],
    ["c2", "!a"],
    ["c3", "!b"],
  ]);
  const result = solve(constraints);
  equal(result.status, "unsat");
  if (result.status !== "unsat") return;
  deepEqual(result.core, ["c1", "c2", "c3"]);
  // a=1 closes on c2 immediately; a=0 splits b, closing on c1 and c3.
  equal(countLeaves(result.proof), 3);
  const coreConstraints = constraints.filter((c) => result.core.includes(c.name));
  const validation = validateProofTree(result.proof, coreConstraints, ["a", "b"]);
  ok(validation.ok, validation.detail);
  ok(result.proofTree.includes("CONTRADICTION c1"));
  ok(result.proofTree.includes("split a"));
});

test("limits: more than 18 named constraints is rejected explicitly", () => {
  const many: [string, string][] = [];
  for (let i = 1; i <= MAX_CONSTRAINTS + 1; i++) many.push([`c${i}`, "a"]);
  throws(() => solve(cs(many)), (err) => err instanceof LimitError && /at most 18 named constraints/.test(err.message));
});

test("limits: more than 18 distinct variables is rejected explicitly", () => {
  const vars = Array.from({ length: 19 }, (_, i) => `v${i}`).join(" | ");
  throws(() => solve(cs([["c1", vars]])), (err) => err instanceof LimitError && /at most 18 distinct variables/.test(err.message));
});

test("limits: exactly 18 constraints and 18 variables are accepted", () => {
  const many: [string, string][] = [];
  for (let i = 1; i <= 18; i++) many.push([`c${i}`, `v${i} | !v${i}`]);
  const result = solve(cs(many));
  equal(result.status, "sat");
});

test("pause/resume: a chopped-up run reaches the same core as an uninterrupted run", () => {
  const constraints = cs([
    ["c1", "a"],
    ["c2", "a | b"],
    ["c3", "!a & b"],
    ["c4", "!b"],
    ["c5", "a <-> b"],
  ]);
  const direct = solve(constraints);
  equal(direct.status, "unsat");

  let frontier: Frontier | undefined = undefined;
  let result: SolveResult;
  for (;;) {
    result = solve(constraints, { stepLimit: 1, frontier });
    if (result.status !== "paused") break;
    frontier = result.frontier;
  }
  equal(result.status, "unsat");
  if (result.status === "unsat" && direct.status === "unsat") {
    deepEqual(result.core, direct.core);
    equal(result.stats.totalSteps, direct.stats.totalSteps);
  }
});

test("pause/resume: SAT result is identical when paused and resumed", () => {
  const constraints = cs([
    ["c1", "a | b"],
    ["c2", "b -> c"],
    ["c3", "!a | !c"],
  ]);
  const direct = solve(constraints);
  let frontier: Frontier | undefined = undefined;
  let result: SolveResult;
  for (;;) {
    result = solve(constraints, { stepLimit: 2, frontier });
    if (result.status !== "paused") break;
    frontier = result.frontier;
  }
  equal(result.status, "sat");
  if (result.status === "sat" && direct.status === "sat") {
    deepEqual(result.assignment, direct.assignment);
    equal(result.assignmentIndex, direct.assignmentIndex);
  }
});

test("conflict cache: valid entry is reused and reports a cache hit", () => {
  const constraints = cs([
    ["c1", "a"],
    ["c2", "a"],
    ["c3", "!a"],
  ]);
  const cold = solve(constraints);
  equal(cold.status, "unsat");
  const warm = solve(constraints, { cache: [{ sources: ["c1", "c3"] }] });
  equal(warm.status, "unsat");
  if (warm.status === "unsat") {
    deepEqual(warm.core, ["c1", "c3"]);
    deepEqual(warm.stats.cacheHit, ["c1", "c3"]);
  }
});

test("conflict cache: entry with a retracted source is NOT reusable", () => {
  // Cache remembers {c1, h1} from an earlier run; h1 has since been removed.
  const constraints = cs([
    ["c1", "a"],
    ["c2", "!a | b"],
  ]);
  const result = solve(constraints, { cache: [{ sources: ["c1", "h1"] }] });
  equal(result.status, "sat"); // stale entry must not make the set look unsat
  if (result.status === "sat") equal(result.stats.cacheHit, null);
});

test("conflict cache: corrupt entry (satisfiable sources) is never trusted", () => {
  const constraints = cs([
    ["c1", "a"],
    ["c2", "b"],
  ]);
  const result = solve(constraints, { cache: [{ sources: ["c1", "c2"] }] });
  equal(result.status, "sat");
});

test("conflict cache: entry still fully present stays reusable across runs", () => {
  const constraints = cs([
    ["c1", "a"],
    ["h1", "!a"],
    ["c2", "b | !b"],
  ]);
  const first = solve(constraints);
  equal(first.status, "unsat");
  const second = solve(constraints, {
    cache: [{ sources: first.status === "unsat" ? first.core : [] }],
  });
  equal(second.status, "unsat");
  if (second.status === "unsat") deepEqual(second.stats.cacheHit, ["c1", "h1"]);
});
