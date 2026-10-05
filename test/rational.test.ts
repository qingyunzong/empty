import { test } from "node:test";
import assert from "node:assert/strict";
import { Rational, R } from "../src/rational.js";

test("normalization: reduces, fixes signs, handles zero", () => {
  assert.equal(R("2/4").toString(), "1/2");
  assert.equal(R("-3/-6").toString(), "1/2");
  assert.equal(R("5/-10").toString(), "-1/2");
  assert.equal(R("0/-7").toString(), "0");
  assert.equal(R(4n).toString(), "4");
  assert.equal(R(-3).toString(), "-3");
});

test("exact decimal parsing: 0.1 is exactly 1/10", () => {
  const tenth = R("0.1");
  assert.equal(tenth.toString(), "1/10");
  let sum = Rational.ZERO;
  for (let i = 0; i < 10; i++) sum = sum.add(tenth);
  assert.equal(sum.toString(), "1"); // 10 * 1/10 === 1 exactly
  assert.equal(R("2.75").toString(), "11/4");
  assert.equal(R("-0.125").toString(), "-1/8");
  assert.equal(R(".5").toString(), "1/2");
});

test("non-integer JS numbers are rejected (no silent float rounding)", () => {
  assert.throws(() => R(0.1), /not exactly representable/);
  assert.throws(() => R(1.5), /not exactly representable/);
  assert.doesNotThrow(() => R(3));
});

test("arithmetic is exact", () => {
  assert.equal(R("1/3").add(R("1/6")).toString(), "1/2");
  assert.equal(R("1/3").sub(R("1/2")).toString(), "-1/6");
  assert.equal(R("2/3").mul(R("9/4")).toString(), "3/2");
  assert.equal(R("2/3").div(R("4/5")).toString(), "5/6");
  assert.equal(R("1/7").add(R("1/13")).toString(), "20/91");
  // big exact values that would lose precision as floats
  const big = R("123456789012345678901234567890/3");
  assert.equal(big.mul(R(3)).toString(), "123456789012345678901234567890");
});

test("comparisons are exact", () => {
  assert.equal(R("1/3").cmp(R("2/6")), 0);
  assert.ok(R("1/3").cmp(R("1/4")) > 0);
  assert.ok(R("-2/3").cmp(R("-1/3")) < 0);
  assert.ok(R("1/10000000000000000001").isPositive());
  assert.ok(R("1/10000000000000000001").cmp(Rational.ZERO) > 0);
});

test("toString round-trips through parse", () => {
  for (const s of ["0", "7", "-13/4", "22/7", "-1/1000000"]) {
    assert.equal(R(s).toString(), s === "0" ? "0" : s);
  }
});

test("division by zero and zero denominator throw", () => {
  assert.throws(() => R("1/0"));
  assert.throws(() => R("1/2").div(Rational.ZERO));
});
