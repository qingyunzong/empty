import { test } from "node:test";
import { equal, deepEqual, throws } from "node:assert/strict";
import { frac, parseFraction, add, sub, mul, div, cmp, formatFraction } from "../src/fraction.js";

test("frac 约分并规范符号", () => {
  deepEqual(frac(6n, 8n), { n: 3n, d: 4n });
  deepEqual(frac(3n, -4n), { n: -3n, d: 4n });
  deepEqual(frac(-6n, -8n), { n: 3n, d: 4n });
  deepEqual(frac(0n, 5n), { n: 0n, d: 1n });
  throws(() => frac(1n, 0n));
});

test("parseFraction 支持分数、整数、有限小数", () => {
  deepEqual(parseFraction("2/3"), { n: 2n, d: 3n });
  deepEqual(parseFraction(" -4/6 "), { n: -2n, d: 3n });
  deepEqual(parseFraction("7"), { n: 7n, d: 1n });
  deepEqual(parseFraction("0.125"), { n: 1n, d: 8n });
  deepEqual(parseFraction("-1.5"), { n: -3n, d: 2n });
  deepEqual(parseFraction(".5"), { n: 1n, d: 2n });
  throws(() => parseFraction("abc"));
  throws(() => parseFraction("1/0"));
});

test("四则运算与比较精确", () => {
  equal(formatFraction(add(parseFraction("1/6"), parseFraction("1/3"))), "1/2");
  equal(formatFraction(sub(parseFraction("1/2"), parseFraction("3/4"))), "-1/4");
  equal(formatFraction(mul(parseFraction("2/3"), parseFraction("9/4"))), "3/2");
  equal(formatFraction(div(parseFraction("1/2"), parseFraction("3/4"))), "2/3");
  equal(cmp(parseFraction("0.333"), parseFraction("1/3")), -1);
  equal(cmp(parseFraction("2/4"), parseFraction("1/2")), 0);
});
