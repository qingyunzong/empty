import { test } from "node:test";
import { deepEqual, throws } from "node:assert/strict";
import { parseExpr } from "../src/parser.js";
import type { Expr } from "../src/ast.js";

const v = (name: string): Expr => ({ kind: "var", name });
const bin = (op: "and" | "or" | "xor" | "implies" | "iff", left: Expr, right: Expr): Expr => ({
  kind: "binary",
  op,
  left,
  right,
});
test("precedence: & binds tighter than |", () => {
  deepEqual(parseExpr("a & b | c"), bin("or", bin("and", v("a"), v("b")), v("c")));
});

test("precedence: | binds tighter than ->, -> is right associative", () => {
  deepEqual(
    parseExpr("a | b -> c -> d"),
    bin("implies", bin("or", v("a"), v("b")), bin("implies", v("c"), v("d")))
  );
});

test("precedence: <-> is the weakest operator", () => {
  deepEqual(parseExpr("a -> b <-> c"), bin("iff", bin("implies", v("a"), v("b")), v("c")));
});

test("negation binds tightest and stacks", () => {
  deepEqual(parseExpr("!!a & b"), {
    kind: "binary",
    op: "and",
    left: { kind: "not", operand: { kind: "not", operand: v("a") } },
    right: v("b"),
  });
});

test("parentheses override precedence", () => {
  deepEqual(parseExpr("a & (b | c)"), bin("and", v("a"), bin("or", v("b"), v("c"))));
});

test("keyword and symbolic operators are equivalent", () => {
  deepEqual(parseExpr("a and not b"), parseExpr("a && !b"));
  deepEqual(parseExpr("a xor b"), parseExpr("a ^ b"));
  deepEqual(parseExpr("a iff b"), parseExpr("a <-> b"));
  deepEqual(parseExpr("a implies b"), parseExpr("a -> b"));
});

test("constants true/false/1/0", () => {
  deepEqual(parseExpr("true"), { kind: "const", value: true });
  deepEqual(parseExpr("false"), { kind: "const", value: false });
  deepEqual(parseExpr("1"), { kind: "const", value: true });
  deepEqual(parseExpr("0"), { kind: "const", value: false });
});

test("parse errors are reported", () => {
  throws(() => parseExpr(""), /empty expression/);
  throws(() => parseExpr("a &"), /unexpected end/);
  throws(() => parseExpr("a b"), /trailing tokens/);
  throws(() => parseExpr("(a"), /unexpected end/);
  throws(() => parseExpr("(a b"), /expected '\)'/);
  throws(() => parseExpr("a $ b"), /unexpected character/);
});
