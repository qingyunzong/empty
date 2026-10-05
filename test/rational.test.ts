import { test } from "node:test";
import assert from "node:assert/strict";
import { Rational } from "../src/rational.ts";

test("reduces and normalizes sign", () => {
  const r = Rational.of(6, -8);
  assert.equal(r.num, -3n);
  assert.equal(r.den, 4n);
  assert.equal(Rational.of(0, 7).toString(), "0");
  assert.equal(Rational.of(-3, -4).toString(), "3/4");
});

test("arithmetic is exact", () => {
  const a = Rational.of(1, 3);
  const b = Rational.of(1, 6);
  assert.equal(a.add(b).toString(), "1/2");
  assert.equal(a.sub(b).toString(), "1/6");
  assert.equal(a.mul(b).toString(), "1/18");
  assert.equal(a.div(b).toString(), "2");
  assert.equal(a.neg().toString(), "-1/3");
  assert.equal(Rational.of(1, 10).add(Rational.of(2, 10)).toString(), "3/10");
});

test("comparison", () => {
  assert.ok(Rational.of(1, 3).lt(Rational.of(1, 2)));
  assert.ok(Rational.of(2, 4).equals(Rational.of(1, 2)));
  assert.ok(Rational.of(-5, 2).le(Rational.of(-2)));
  assert.ok(Rational.of(5).gt(Rational.of(9, 2)));
  assert.equal(Rational.of(7, 3).cmp(Rational.of(7, 3)), 0);
});

test("rejects zero denominator and non-integer numbers", () => {
  assert.throws(() => Rational.of(1, 0));
  assert.throws(() => Rational.of(0.5));
  assert.throws(() => Rational.of(1).div(Rational.of(0)));
});
