import { test } from "node:test";
import { equal, ok, throws } from "node:assert/strict";
import { Rational } from "../src/rational.js";

test("normalizes to lowest terms with positive denominator", () => {
  const r = Rational.of(6, -9);
  equal(r.num, -2n);
  equal(r.den, 3n);
  equal(Rational.of(4, 2).toString(), "2");
  equal(Rational.of(0, 7).toString(), "0");
});

test("arithmetic stays exact", () => {
  const third = Rational.of(1, 3);
  const sixth = Rational.of(1, 6);
  ok(third.add(sixth).equals(Rational.of(1, 2)));
  ok(third.sub(sixth).equals(sixth));
  ok(third.mul(sixth).equals(Rational.of(1, 18)));
  ok(third.div(sixth).equals(Rational.of(2)));
  ok(third.neg().add(third).equals(Rational.zero()));
});

test("comparison and integer access", () => {
  equal(Rational.of(1, 3).cmp(Rational.of(2, 7)), 1);
  equal(Rational.of(2, 6).cmp(Rational.of(1, 3)), 0);
  throws(() => Rational.of(-5, 2).toBigInt());
  equal(Rational.of(-4, 2).toBigInt(), -2n);
  throws(() => Rational.of(1, 0));
  throws(() => Rational.of(1, 2).div(Rational.zero()));
});
