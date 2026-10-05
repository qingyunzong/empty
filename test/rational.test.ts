import { test } from "node:test";
import assert from "node:assert/strict";
import { Rational } from "../src/rational.js";

test("construction normalizes to lowest terms", () => {
  const r = Rational.of(6n, 8n);
  assert.equal(r.num, 3n);
  assert.equal(r.den, 4n);
  assert.equal(Rational.of(5, -10).toString(), "-1/2");
  assert.equal(Rational.of(-5, -10).toString(), "1/2");
});

test("arithmetic is exact", () => {
  const third = Rational.of(1, 3);
  const sixth = Rational.of(1, 6);
  assert.equal(third.add(sixth).toString(), "1/2");
  assert.equal(third.sub(sixth).toString(), "1/6");
  assert.equal(third.mul(sixth).toString(), "1/18");
  assert.equal(third.div(sixth).toString(), "2");
  assert.equal(third.neg().toString(), "-1/3");
});

test("decimal parsing is exact (no floating point)", () => {
  const a = Rational.parse("0.1");
  const b = Rational.parse("0.2");
  assert.equal(a.add(b).toString(), "3/10");
  assert.equal(Rational.parse("1.5e-2").toString(), "3/200");
  assert.equal(Rational.parse("2e3").toString(), "2000");
  assert.equal(Rational.parse(".5").toString(), "1/2");
  assert.equal(Rational.parse("5.").toString(), "5");
});

test("integer powers, including negative and zero", () => {
  assert.equal(Rational.of(2, 3).pow(3).toString(), "8/27");
  assert.equal(Rational.of(2, 3).pow(-2).toString(), "9/4");
  assert.equal(Rational.of(7, 9).pow(0).toString(), "1");
});

test("zero handling", () => {
  assert.ok(Rational.ZERO.isZero());
  assert.ok(Rational.parse("0.000").isZero());
  assert.throws(() => Rational.of(1, 0));
  assert.throws(() => Rational.ONE.div(Rational.ZERO));
});
