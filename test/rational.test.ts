import { test } from "node:test";
import assert from "node:assert/strict";
import { Rational } from "../src/rational";

test("normalizes to lowest terms with positive denominator", () => {
  const r = Rational.of(6, -8);
  assert.equal(r.num, -3n);
  assert.equal(r.den, 4n);
  assert.equal(Rational.of(10, 5).toString(), "2");
});

test("arithmetic is exact", () => {
  const a = Rational.of(1, 3);
  const b = Rational.of(1, 6);
  assert.equal(a.add(b).toString(), "1/2");
  assert.equal(a.sub(b).toString(), "1/6");
  assert.equal(a.mul(b).toString(), "1/18");
  assert.equal(a.div(b).toString(), "2");
  assert.equal(a.neg().toString(), "-1/3");
});

test("comparison and equality", () => {
  assert.equal(Rational.of(1, 3).cmp(Rational.of(2, 7)), 1);
  assert.equal(Rational.of(2, 7).cmp(Rational.of(1, 3)), -1);
  assert.ok(Rational.of(2, 4).equals(Rational.of(1, 2)));
});

test("parse round-trips toString", () => {
  for (const s of ["0", "7", "-3", "22/7", "-5/9"]) {
    assert.equal(Rational.parse(s).toString(), s);
  }
});

test("rejects zero denominator and division by zero", () => {
  assert.throws(() => Rational.of(1, 0));
  assert.throws(() => Rational.of(1).div(Rational.zero()));
});
