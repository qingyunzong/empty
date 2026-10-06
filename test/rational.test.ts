import { test } from "node:test";
import assert from "node:assert/strict";
import { Rational, ceilDiv, floorDiv, gcdBig, lcmBig } from "../src/rational.js";

test("parse and normalize fractions", () => {
  assert.equal(Rational.parse("3/6").toString(), "1/2");
  assert.equal(Rational.parse("-4/6").toString(), "-2/3");
  assert.equal(Rational.parse(" 2 / 5 ").toString(), "2/5");
  assert.equal(Rational.parse("7").toString(), "7");
  assert.equal(Rational.parse("-3").toString(), "-3");
});

test("parse decimals exactly", () => {
  assert.equal(Rational.parse("0.5").toString(), "1/2");
  assert.equal(Rational.parse("-0.125").toString(), "-1/8");
  assert.equal(Rational.parse("1.5e2").toString(), "150");
  assert.equal(Rational.parse("2.5e-2").toString(), "1/40");
  assert.equal(Rational.from(0.1).toString(), "1/10");
});

test("parse rejects invalid input", () => {
  assert.throws(() => Rational.parse("abc"));
  assert.throws(() => Rational.parse("1/0"));
  assert.throws(() => Rational.parse("6/-8"));
  assert.throws(() => Rational.parse("1.2.3"));
  assert.throws(() => Rational.parse(""));
});

test("arithmetic is exact", () => {
  const third = Rational.parse("1/3");
  const sixth = Rational.parse("1/6");
  assert.equal(third.add(sixth).toString(), "1/2");
  assert.equal(third.sub(sixth).toString(), "1/6");
  assert.equal(third.mul(sixth).toString(), "1/18");
  assert.equal(third.div(sixth).toString(), "2");
  assert.equal(third.neg().toString(), "-1/3");
  // 0.1 + 0.2 != 0.3 in floats, but exact here
  assert.equal(Rational.parse("0.1").add(Rational.parse("0.2")).toString(), "3/10");
});

test("comparisons", () => {
  const a = Rational.parse("1/3");
  const b = Rational.parse("2/7");
  assert.ok(a.gt(b));
  assert.ok(b.lt(a));
  assert.ok(a.ge(Rational.parse("1/3")));
  assert.ok(a.le(Rational.parse("1/3")));
  assert.ok(a.eq(Rational.parse("2/6")));
  assert.equal(a.cmp(b), 1);
});

test("floor and ceil handle negatives", () => {
  const v = Rational.parse("-7/2");
  assert.equal(v.floor(), -4n);
  assert.equal(v.ceil(), -3n);
  assert.equal(Rational.parse("7/2").floor(), 3n);
  assert.equal(Rational.parse("7/2").ceil(), 4n);
  assert.equal(Rational.parse("4/2").floor(), 2n);
  assert.equal(Rational.parse("4/2").ceil(), 2n);
});

test("bigint helpers", () => {
  assert.equal(gcdBig(12n, 18n), 6n);
  assert.equal(gcdBig(0n, 5n), 5n);
  assert.equal(gcdBig(-12n, 18n), 6n);
  assert.equal(lcmBig(4n, 6n), 12n);
  assert.equal(floorDiv(-7n, 2n), -4n);
  assert.equal(ceilDiv(-7n, 2n), -3n);
  assert.equal(floorDiv(7n, 2n), 3n);
  assert.equal(ceilDiv(7n, 2n), 4n);
});
