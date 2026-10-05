import assert from "node:assert/strict";
import test from "node:test";
import { runQuery } from "../src/engine.js";
import { triAnd, triNot, triOr } from "../src/values.js";
import type { Expr } from "../src/types.js";

test("3VL truth tables", () => {
  const T = true, F = false, U = null;
  // AND
  assert.equal(triAnd(T, T), true);
  assert.equal(triAnd(T, F), false);
  assert.equal(triAnd(T, U), null);
  assert.equal(triAnd(F, U), false);
  assert.equal(triAnd(U, U), null);
  // OR
  assert.equal(triOr(T, U), true);
  assert.equal(triOr(F, U), null);
  assert.equal(triOr(F, F), false);
  assert.equal(triOr(U, U), null);
  // NOT
  assert.equal(triNot(T), false);
  assert.equal(triNot(F), true);
  assert.equal(triNot(U), null);
});

const tables = {
  t: {
    rows: [
      { a: 1, b: 1 },
      { a: 1, b: null },
      { a: null, b: 1 },
      { a: null, b: null },
      { a: 2, b: 2 },
    ],
  },
};

function countWhere(where: Expr): number {
  return runQuery(
    { from: { table: "t" }, where, select: [{ agg: { fn: "count", arg: "*" }, as: "n" }] },
    tables,
  )[0]!["n"] as number;
}

test("NULL comparison is UNKNOWN and WHERE keeps only TRUE", () => {
  // a = b: true only for (1,1) and (2,2); rows with NULL are UNKNOWN, dropped.
  assert.equal(countWhere({ op: "eq", args: [{ col: "a" }, { col: "b" }] }), 2);
  // a <> b: never TRUE on this data (NULLs make it UNKNOWN).
  assert.equal(countWhere({ op: "ne", args: [{ col: "a" }, { col: "b" }] }), 0);
  // a = NULL is UNKNOWN even for NULL rows: nothing passes.
  assert.equal(countWhere({ op: "eq", args: [{ col: "a" }, { lit: null }] }), 0);
  // IS NULL recovers the NULL rows.
  assert.equal(countWhere({ op: "isNull", arg: { col: "a" } }), 2);
  // NOT (a = b): UNKNOWN stays UNKNOWN, still filtered out.
  assert.equal(
    countWhere({ op: "not", arg: { op: "eq", args: [{ col: "a" }, { col: "b" }] } }),
    0,
  );
  // (a = b) OR (a IS NULL): TRUE for (1,1),(2,2) and the two a-NULL rows.
  assert.equal(
    countWhere({
      op: "or",
      args: [
        { op: "eq", args: [{ col: "a" }, { col: "b" }] },
        { op: "isNull", arg: { col: "a" } },
      ],
    }),
    4,
  );
});
