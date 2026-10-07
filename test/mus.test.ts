import { test } from "node:test";
import { deepEqual, equal, match, ok } from "node:assert/strict";
import { parseExpr } from "../src/parser.js";
import {
  combinations,
  findMinimumUnsatSubset,
  renderProofTree,
  type MusFrontier,
  type NamedExpr,
} from "../src/mus.js";
import { MAX_CONSTRAINTS } from "../src/solver.js";

function named(defs: Record<string, string>): NamedExpr[] {
  return Object.entries(defs).map(([id, src]) => ({ id, expr: parseExpr(src) }));
}

test("combinations are generated in lexicographic tuple order", () => {
  deepEqual([...combinations(["a", "b", "c"], 2)], [["a", "b"], ["a", "c"], ["b", "c"]]);
  deepEqual([...combinations(["a", "b", "c"], 0)], [[]]);
  deepEqual([...combinations(["a", "b", "c"], 3)], [["a", "b", "c"]]);
});

test("finds the minimum unsatisfiable subset with a full minimality proof", () => {
  const defs = named({
    c1: "a | b",
    c2: "!a",
    c3: "!b & (a -> c)",
    c4: "!c",
  });
  const result = findMinimumUnsatSubset(defs, ["a", "b", "c"]);
  if (result.status !== "unsat") throw new Error("expected unsat");
  deepEqual(result.mus, ["c1", "c2", "c3"]);
  // Every subset of size < 3 must have been checked and be satisfiable:
  // C(4,0)+C(4,1)+C(4,2) = 1+4+6 = 11.
  const smaller = result.checks.filter((c) => c.ids.length < 3);
  equal(smaller.length, 11);
  ok(smaller.every((c) => c.sat && c.witness !== undefined));
});

test("ties between minimum cores are broken by smallest id order", () => {
  const defs = named({
    c1: "a",
    c2: "!a",
    c3: "b",
    c4: "!b",
  });
  const result = findMinimumUnsatSubset(defs, ["a", "b"]);
  if (result.status !== "unsat") throw new Error("expected unsat");
  deepEqual(result.mus, ["c1", "c2"]); // not ["c3", "c4"]
});

test("id order, not file order, decides ties", () => {
  const defs = named({
    z9: "a",
    a1: "!a",
    z8: "b",
    a2: "!b",
  });
  const result = findMinimumUnsatSubset(defs, ["a", "b"]);
  if (result.status !== "unsat") throw new Error("expected unsat");
  deepEqual(result.mus, ["a1", "z9"]); // sorted ids, lexicographically smallest core
});

test("satisfiable input yields the lexicographically smallest assignment", () => {
  const defs = named({ c1: "a | b", c2: "!a -> c" });
  const result = findMinimumUnsatSubset(defs, ["a", "b", "c"]);
  if (result.status !== "sat") throw new Error("expected sat");
  deepEqual(result.assignment, { a: false, b: true, c: true });
});

test("proof tree shows the core, its witnesses, and the minimality count", () => {
  const defs = named({ c1: "a | b", c2: "!a", c3: "!b & (a -> c)", c4: "!c" });
  const result = findMinimumUnsatSubset(defs, ["a", "b", "c"]);
  if (result.status !== "unsat") throw new Error("expected unsat");
  const tree = renderProofTree(result.mus, result.checks);
  match(tree, /UNSAT \{c1, c2, c3\}.*size 3/);
  match(tree, /\{c2, c3\} SAT {2}witness: a=0 b=0 c=0/);
  match(tree, /\{c1, c2\} SAT {2}witness: a=0 b=1 c=0/);
  match(tree, /minimality: all 11 subset\(s\) of size < 3/);
});

test("paused search resumes to the identical result", () => {
  const defs = named({
    c1: "a | b",
    c2: "!a",
    c3: "!b & (a -> c)",
    c4: "!c",
  });
  const vars = ["a", "b", "c"];
  const full = findMinimumUnsatSubset(defs, vars);
  if (full.status !== "unsat") throw new Error("expected unsat");

  let frontier: MusFrontier | undefined;
  let final;
  for (let i = 0; i < 100; i++) {
    const part = findMinimumUnsatSubset(defs, vars, {
      stepBudget: 3,
      ...(frontier !== undefined ? { frontier } : {}),
    });
    if (part.status === "paused") {
      frontier = part.frontier;
      continue;
    }
    final = part;
    break;
  }
  if (final === undefined || final.status !== "unsat") throw new Error("expected unsat");
  deepEqual(final.mus, full.mus);
  deepEqual(final.checks, full.checks);
});

test("constraint limit is explicit and enforced", () => {
  const defs: NamedExpr[] = [];
  for (let i = 0; i < MAX_CONSTRAINTS + 1; i++) {
    defs.push({ id: `c${i}`, expr: parseExpr("true") });
  }
  throwsLike(() => findMinimumUnsatSubset(defs, []), /exhaustive input limit exceeded/);
});

function throwsLike(fn: () => void, pattern: RegExp): void {
  let threw = false;
  try {
    fn();
  } catch (err) {
    threw = true;
    match(err instanceof Error ? err.message : String(err), pattern);
  }
  ok(threw, "expected the call to throw");
}
