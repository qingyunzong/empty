import { test } from "node:test";
import assert from "node:assert/strict";
import { evaluateToString } from "../src/index.js";
import { parse } from "../src/parser.js";
import { evaluate } from "../src/evaluate.js";
import { CalcError, UnitError } from "../src/errors.js";

test("addition and subtraction of like dimensions", () => {
  assert.equal(evaluateToString("3 m + 2 m"), "5 m");
  assert.equal(evaluateToString("1 km + 1 m"), "1001 m");
  assert.equal(evaluateToString("1 h + 30 min"), "5400 s");
  assert.equal(evaluateToString("5 N - 2 N"), "3 kg*m*s^-2");
});

test("multiplication and division merge dimension vectors", () => {
  assert.equal(evaluateToString("2 m * 3 m"), "6 m^2");
  assert.equal(evaluateToString("10 m / 2 s"), "5 m*s^-1");
  assert.equal(evaluateToString("6 m^2 / 2 m"), "3 m");
  assert.equal(evaluateToString("1 N * 1 m"), "1 kg*m^2*s^-2");
  assert.equal(evaluateToString("1 J / 1 N"), "1 m");
});

test("dimensionless results and pure numbers", () => {
  assert.equal(evaluateToString("2 m / 4 m"), "1/2");
  assert.equal(evaluateToString("1 + 2 * 3"), "7");
  assert.equal(evaluateToString("(1 + 2) * 3"), "9");
});

test("powers scale the dimension vector", () => {
  assert.equal(evaluateToString("(2 m)^2"), "4 m^2");
  assert.equal(evaluateToString("(3 s)^-1"), "1/3 s^-1");
  assert.equal(evaluateToString("2 m^2 * 3 m^-1"), "6 m");
});

test("exact rational arithmetic, no floating point drift", () => {
  assert.equal(evaluateToString("1 m / 3 s"), "1/3 m*s^-1");
  assert.equal(evaluateToString("0.1 m + 0.2 m"), "3/10 m");
  assert.equal(evaluateToString("2/3"), "2/3");
});

test("dimension mismatch on + and - raises UnitError with ranges and units", () => {
  const src = "12 m + 4 s";
  try {
    evaluate(parse(src));
    assert.fail("should have thrown");
  } catch (e) {
    assert.ok(e instanceof UnitError);
    assert.equal(e.start, 0);
    assert.equal(e.end, src.length);
    assert.deepEqual(
      { s: e.left.start, e: e.left.end, u: e.left.unit },
      { s: 0, e: 4, u: "m" },
    );
    assert.deepEqual(
      { s: e.right.start, e: e.right.end, u: e.right.unit },
      { s: 7, e: 10, u: "s" },
    );
    assert.match(e.message, /dimension mismatch for '\+': left is 'm' \(0\.\.4\), right is 's' \(7\.\.10\)/);
  }
});

test("zero is NOT exempt from the dimension check", () => {
  assert.throws(() => evaluate(parse("0 m + 0 s")), UnitError);
  assert.throws(() => evaluate(parse("0 + 1 m")), UnitError);
  assert.throws(() => evaluate(parse("0 m - 0 kg")), UnitError);
  // ...but zero with matching dimensions is fine.
  assert.equal(evaluateToString("0 m + 0 m"), "0 m");
  assert.equal(evaluateToString("0 + 0"), "0");
});

test("mismatch inside a nested subexpression reports the inner range", () => {
  const src = "2 * (1 m + 1 s) + 3 m";
  try {
    evaluate(parse(src));
    assert.fail("should have thrown");
  } catch (e) {
    assert.ok(e instanceof UnitError);
    assert.equal(src.slice(e.start, e.end), "(1 m + 1 s)");
    assert.equal(e.left.unit, "m");
    assert.equal(e.right.unit, "s");
  }
});

test("division by zero reports the subexpression range", () => {
  const src = "1 m / (2 - 2)";
  try {
    evaluate(parse(src));
    assert.fail("should have thrown");
  } catch (e) {
    assert.ok(e instanceof CalcError);
    assert.ok(!(e instanceof UnitError));
    assert.equal(src.slice(e.start, e.end), src);
    assert.match(e.message, /division by zero/);
  }
});

test("derived units agree with their base-unit expansion", () => {
  assert.equal(evaluateToString("1 N"), evaluateToString("1 kg * 1 m / 1 s^2"));
  assert.equal(evaluateToString("1 J"), evaluateToString("1 N * 1 m"));
  assert.equal(evaluateToString("1 W"), evaluateToString("1 J / 1 s"));
  assert.equal(evaluateToString("1 Pa"), evaluateToString("1 N / 1 m^2"));
  assert.equal(evaluateToString("60 Hz"), evaluateToString("60 s^-1"));
});
