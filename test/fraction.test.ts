import { test } from "node:test";
import assert from "node:assert/strict";
import { Fraction } from "../src/fraction";

test("normalizes sign and gcd", () => {
  const f = Fraction.of(6, -8);
  assert.equal(f.num, -3n);
  assert.equal(f.den, 4n);
  assert.equal(Fraction.of(0, 5).toString(), "0");
});

test("parses fractions, decimals, integers", () => {
  assert.ok(Fraction.parse("3/4").eq(Fraction.of(3, 4)));
  assert.ok(Fraction.parse("1.5").eq(Fraction.of(3, 2)));
  assert.ok(Fraction.parse("-0.25").eq(Fraction.of(-1, 4)));
  assert.ok(Fraction.parse("120").eq(Fraction.of(120)));
});

test("arithmetic is exact", () => {
  const a = Fraction.of(1, 3);
  const b = Fraction.of(1, 6);
  assert.ok(a.add(b).eq(Fraction.of(1, 2)));
  assert.ok(a.sub(b).eq(Fraction.of(1, 6)));
  assert.ok(a.mul(b).eq(Fraction.of(1, 18)));
  assert.ok(a.div(b).eq(Fraction.of(2)));
  // 1/3 + 1/3 + 1/3 === 1 exactly (float would give 0.9999999999999999)
  assert.ok(a.add(a).add(a).eq(Fraction.of(1)));
});

test("comparison", () => {
  assert.ok(Fraction.of(1, 3).gt(Fraction.of(1, 4)));
  assert.ok(Fraction.of(2, 4).eq(Fraction.of(1, 2)));
  assert.equal(Fraction.of(-1).cmp(Fraction.of(1)), -1);
});

test("rejects zero denominator and division by zero", () => {
  assert.throws(() => Fraction.of(1, 0));
  assert.throws(() => Fraction.of(1).div(Fraction.ZERO));
});
