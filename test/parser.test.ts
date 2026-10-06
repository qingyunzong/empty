import test from "node:test";
import assert from "node:assert/strict";
import { ParseError, parseConstraint } from "../src/parser.js";

function linOf(c: ReturnType<typeof parseConstraint>) {
  return { kind: c.kind, coefs: Object.fromEntries(c.expr.coefs), konst: c.expr.konst };
}

test("parses a simple inequality and normalizes to <= 0", () => {
  const c = parseConstraint("2*x + 3 <= 10");
  assert.equal(c.kind, "ineq");
  assert.deepEqual(linOf(c), { kind: "ineq", coefs: { x: 2n }, konst: -7n });
});

test("strict inequality is shifted by exactly 1 (no floats)", () => {
  const c = parseConstraint("x < 9223372036854775807");
  assert.equal(c.kind, "ineq");
  assert.deepEqual(linOf(c), { kind: "ineq", coefs: { x: 1n }, konst: -9223372036854775806n });
});

test("greater-than is negated", () => {
  const c = parseConstraint("3*x - 1 > 5");
  // 3x - 1 > 5  <=>  3x - 6 > 0  <=>  -3x + 7 <= 0
  assert.deepEqual(linOf(c), { kind: "ineq", coefs: { x: -3n }, konst: 7n });
});

test("equality", () => {
  const c = parseConstraint("3*x == 12");
  assert.equal(c.kind, "eq");
  assert.deepEqual(linOf(c), { kind: "eq", coefs: { x: 3n }, konst: -12n });
});

test("congruence with % syntax", () => {
  const c = parseConstraint("(2*x + 1) % 6 == 4");
  assert.equal(c.kind, "cong");
  if (c.kind !== "cong") throw new Error("unreachable");
  assert.equal(c.modulus, 6n);
  assert.deepEqual(linOf(c), { kind: "cong", coefs: { x: 2n }, konst: -3n });
});

test("congruence with (mod m) suffix and ≡", () => {
  const c = parseConstraint("2*x + 1 ≡ 4 (mod 6)");
  assert.equal(c.kind, "cong");
  if (c.kind !== "cong") throw new Error("unreachable");
  assert.equal(c.modulus, 6n);
  const d = parseConstraint("x == 3 (mod 7)");
  assert.equal(d.kind, "cong");
});

test("unicode ≤ and ≥ are accepted", () => {
  assert.equal(parseConstraint("x ≤ 5").kind, "ineq");
  assert.equal(parseConstraint("x ≥ 5").kind, "ineq");
});

test("rejects non-linear terms, !=, division, bad modulus", () => {
  assert.throws(() => parseConstraint("x*x <= 4"), ParseError);
  assert.throws(() => parseConstraint("x != 4"), ParseError);
  assert.throws(() => parseConstraint("x / 2 <= 4"), ParseError);
  assert.throws(() => parseConstraint("x % 0 == 1"), ParseError);
  assert.throws(() => parseConstraint("x % -3 == 1"), ParseError);
  assert.throws(() => parseConstraint("x % y == 1"), ParseError);
  assert.throws(() => parseConstraint("x <= 4 (mod 3)"), ParseError);
});
