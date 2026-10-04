import { test } from "node:test";
import assert from "node:assert/strict";
import { parse, add, sub, mul, div, abs, cmp, toString, rat } from "../src/rational.js";

test("parses integers, decimals and fractions exactly", () => {
  assert.equal(toString(parse("3")), "3");
  assert.equal(toString(parse("-7")), "-7");
  assert.equal(toString(parse("3/4")), "3/4");
  assert.equal(toString(parse("6/8")), "3/4");
  assert.equal(toString(parse("1.25")), "5/4");
  assert.equal(toString(parse("-0.5")), "-1/2");
  assert.equal(toString(parse("2.5/0.5")), "5");
});

test("rejects malformed input", () => {
  assert.throws(() => parse("1/0"));
  assert.throws(() => parse("abc"));
  assert.throws(() => parse("1/2/3"));
});

test("arithmetic stays exact and reduced", () => {
  assert.equal(toString(add(parse("1/3"), parse("1/6"))), "1/2");
  assert.equal(toString(sub(parse("1/2"), parse("3/4"))), "-1/4");
  assert.equal(toString(mul(parse("2/3"), parse("9/4"))), "3/2");
  assert.equal(toString(div(parse("3/4"), parse("1/8"))), "6");
  assert.equal(toString(abs(parse("-5/7"))), "5/7");
  assert.equal(cmp(parse("1/3"), parse("2/7")), 1);
  assert.equal(cmp(rat(2n, 4n), rat(1n, 2n)), 0);
});
