import test from "node:test";
import assert from "node:assert";
import { parseProblem, ParseError, INT64_MAX, INT64_MIN } from "../src/parser";

test("parses variable domains including int64 extremes", () => {
  const p = parseProblem(`var x in [${INT64_MIN}, ${INT64_MAX}]\nvar y in [-5, 10]`);
  assert.equal(p.domains.get("x")!.lo, INT64_MIN);
  assert.equal(p.domains.get("x")!.hi, INT64_MAX);
  assert.equal(p.domains.get("y")!.hi, 10n);
});

test("rejects domains outside int64 or empty", () => {
  assert.throws(() => parseProblem(`var x in [0, ${INT64_MAX + 1n}]`), ParseError);
  assert.throws(() => parseProblem("var x in [5, 4]"), ParseError);
});

test("parses inequalities and normalizes to lhs OP 0", () => {
  const p = parseProblem("var x in [0, 100]\n2*x + 3 <= 15\nx + 1 >= 2*x - 3");
  const [c1, c2] = p.constraints;
  assert.equal(c1!.kind, "ineq");
  if (c1!.kind === "ineq") {
    assert.equal(c1!.op, "<=");
    assert.equal(c1!.expr.coeffs.get("x"), 2n);
    assert.equal(c1!.expr.constant, -12n);
  }
  if (c2!.kind === "ineq") {
    assert.equal(c2!.expr.coeffs.get("x"), -1n);
    assert.equal(c2!.expr.constant, 4n);
  }
});

test("parses both congruence syntaxes", () => {
  const p = parseProblem("var x in [0, 100]\nx % 7 == 3\n2*x + 1 == 5 (mod 12)");
  const [c1, c2] = p.constraints;
  assert.equal(c1!.kind, "cong");
  if (c1!.kind === "cong") {
    assert.equal(c1!.modulus, 7n);
    assert.equal(c1!.expr.constant, -3n);
  }
  if (c2!.kind === "cong") {
    assert.equal(c2!.modulus, 12n);
    assert.equal(c2!.expr.coeffs.get("x"), 2n);
    assert.equal(c2!.expr.constant, -4n);
  }
});

test("parses comments, parentheses and unary minus", () => {
  const p = parseProblem("# demo\nvar x in [-10, 10] # domain\n-(x + 3) <= 2*(x - 1)");
  const c = p.constraints[0]!;
  if (c.kind === "ineq") {
    assert.equal(c.expr.coeffs.get("x"), -3n);
    assert.equal(c.expr.constant, -1n);
  } else {
    assert.fail("expected inequality");
  }
});

test("rejects non-linear terms, unknown variables, bad modulus", () => {
  assert.throws(() => parseProblem("var x in [0, 9]\nx*x <= 3"), ParseError);
  assert.throws(() => parseProblem("var x in [0, 9]\ny <= 3"), ParseError);
  assert.throws(() => parseProblem("var x in [0, 9]\nx % 0 == 1"), ParseError);
  assert.throws(() => parseProblem("var x in [0, 9]\nvar x in [0, 9]"), ParseError);
});
