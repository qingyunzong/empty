import { test } from "node:test";
import { deepEqual, equal, throws } from "node:assert/strict";
import { parseExpr } from "../src/parser.js";
import { assignmentAtRow, solveConjunction, MAX_VARS } from "../src/solver.js";
import type { Expr } from "../src/ast.js";

const p = parseExpr;

test("lexicographically smallest assignment prefers 0 for earlier variables", () => {
  const out = solveConjunction([p("a | b")], { vars: ["a", "b"] });
  if (out.status !== "sat") throw new Error("expected sat");
  deepEqual(out.assignment, { a: false, b: true });
});

test("unsatisfiable conjunction scans the whole table", () => {
  const out = solveConjunction([p("a & !a")], { vars: ["a"] });
  equal(out.status, "unsat");
  equal(out.steps, 2);
});

test("row 0 is the all-false assignment, last row all-true", () => {
  deepEqual(assignmentAtRow(["x", "y", "z"], 0), { x: false, y: false, z: false });
  deepEqual(assignmentAtRow(["x", "y", "z"], 7), { x: true, y: true, z: true });
  deepEqual(assignmentAtRow(["x", "y", "z"], 5), { x: true, y: false, z: true });
});

test("empty conjunction is satisfied by the all-false assignment", () => {
  const out = solveConjunction([], { vars: ["a", "b"] });
  if (out.status !== "sat") throw new Error("expected sat");
  deepEqual(out.assignment, { a: false, b: false });
});

test("pause and resume reproduce the uninterrupted result", () => {
  const vars = ["a", "b", "c", "d", "e", "f", "g", "h"];
  // Only satisfied by the single row a..h = 10110010.
  const exprs: Expr[] = [p("a & !b & c & d & !e & !f & g & !h")];
  const full = solveConjunction(exprs, { vars });
  if (full.status !== "sat") throw new Error("expected sat");

  let row = 0;
  let resumed;
  for (;;) {
    const part = solveConjunction(exprs, { vars, startIndex: row, stepBudget: 50 });
    if (part.status === "paused") {
      row = part.nextRowIndex;
      continue;
    }
    resumed = part;
    break;
  }
  if (resumed === undefined || resumed.status !== "sat") throw new Error("expected sat");
  deepEqual(resumed.assignment, full.assignment);
  equal(resumed.rowIndex, full.rowIndex);
});

test("unsat scan pauses mid-table and finishes after resume", () => {
  const vars = ["a", "b", "c", "d"];
  const exprs = [p("a & !a")];
  const first = solveConjunction(exprs, { vars, stepBudget: 5 });
  if (first.status !== "paused") throw new Error("expected paused");
  equal(first.nextRowIndex, 5);
  const second = solveConjunction(exprs, { vars, startIndex: first.nextRowIndex });
  equal(second.status, "unsat");
  equal(first.steps + second.steps, 16);
});

test("variable limit is explicit and enforced", () => {
  const vars = Array.from({ length: MAX_VARS + 1 }, (_, i) => `v${i}`);
  throws(() => solveConjunction([p("v0")], { vars }), /exhaustive input limit exceeded/);
});
