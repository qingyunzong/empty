import { test } from "node:test";
import assert from "node:assert/strict";
import { Rational, roundHalfEven, floorRational, ceilRational } from "../src/rational.ts";

test("normalizes sign and reduces", () => {
  const r = Rational.of(6, -8);
  assert.equal(r.num, -3n);
  assert.equal(r.den, 4n);
  assert.equal(Rational.of(0, 5).toString(), "0");
});

test("arithmetic is exact", () => {
  const a = Rational.of(1, 3);
  const b = Rational.of(1, 6);
  assert.ok(a.add(b).equals(Rational.of(1, 2)));
  assert.ok(a.sub(b).equals(Rational.of(1, 6)));
  assert.ok(a.mul(b).equals(Rational.of(1, 18)));
  assert.ok(a.div(b).equals(Rational.of(2)));
  assert.equal(a.cmp(b), 1);
  assert.equal(b.cmp(a), -1);
  assert.equal(a.cmp(Rational.of(2, 6)), 0);
});

test("floor and ceil", () => {
  assert.equal(floorRational(Rational.of(7, 2)), 3n);
  assert.equal(ceilRational(Rational.of(7, 2)), 4n);
  assert.equal(floorRational(Rational.of(-7, 2)), -4n);
  assert.equal(ceilRational(Rational.of(-7, 2)), -3n);
  assert.equal(floorRational(Rational.of(4)), 4n);
  assert.equal(ceilRational(Rational.of(4)), 4n);
});

test("round-half-even", () => {
  assert.equal(roundHalfEven(Rational.of(5, 2)), 2n); // 2.5 -> 2
  assert.equal(roundHalfEven(Rational.of(7, 2)), 4n); // 3.5 -> 4
  assert.equal(roundHalfEven(Rational.of(12, 5)), 2n); // 2.4 -> 2
  assert.equal(roundHalfEven(Rational.of(13, 5)), 3n); // 2.6 -> 3
  assert.equal(roundHalfEven(Rational.of(-5, 2)), -2n); // -2.5 -> -2
  assert.equal(roundHalfEven(Rational.of(-7, 2)), -4n); // -3.5 -> -4
  assert.equal(roundHalfEven(Rational.of(3)), 3n);
});
