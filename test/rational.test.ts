import test from "node:test";
import { equal, ok } from "node:assert/strict";
import { add, cmp, make, neg, parse, sub, toString } from "../src/rational.ts";

test("parse and reduce", () => {
  equal(toString(parse("3/6")), "1/2");
  equal(toString(parse("-0.25")), "-1/4");
  equal(toString(parse("7")), "7");
  equal(toString(parse("2/-4")), "-1/2");
});

test("arithmetic", () => {
  equal(toString(add(parse("1/2"), parse("1/3"))), "5/6");
  equal(toString(sub(parse("1/2"), parse("3/4"))), "-1/4");
  equal(toString(neg(parse("5/7"))), "-5/7");
  ok(cmp(parse("1/3"), parse("1/2")) < 0);
  ok(cmp(make(2n, 4n), make(1n, 2n)) === 0);
});
