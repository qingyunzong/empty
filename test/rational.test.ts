import { test } from "node:test";
import assert from "node:assert/strict";
import {
  rational,
  parseRational,
  cmpRational,
  addRational,
  midRational,
  formatRational,
} from "../src/rational.js";

test("normalizes sign and reduces to lowest terms", () => {
  assert.deepEqual(rational(2n, 4n), { n: 1n, d: 2n });
  assert.deepEqual(rational(3n, -6n), { n: -1n, d: 2n });
  assert.deepEqual(rational(-4n, -8n), { n: 1n, d: 2n });
  assert.deepEqual(rational(0n, 7n), { n: 0n, d: 1n });
});

test("rejects zero denominator", () => {
  assert.throws(() => rational(1n, 0n), /zero denominator/);
});

test("parses integers, fractions and decimals exactly", () => {
  assert.deepEqual(parseRational("2"), { n: 2n, d: 1n });
  assert.deepEqual(parseRational("-3/4"), { n: -3n, d: 4n });
  assert.deepEqual(parseRational("0.5"), { n: 1n, d: 2n });
  assert.deepEqual(parseRational("+1.25"), { n: 5n, d: 4n });
  // 1.1 is exactly 11/10, not the float 0.1 approximation
  assert.deepEqual(parseRational("1.1"), { n: 11n, d: 10n });
  assert.throws(() => parseRational("abc"), /cannot parse/);
  assert.throws(() => parseRational("1/0"), /zero denominator/);
});

test("compares exactly where floats fail", () => {
  // 0.1 + 0.2 !== 0.3 in IEEE-754, but 1/10 + 2/10 === 3/10 here.
  const a = addRational(parseRational("0.1"), parseRational("0.2"));
  assert.equal(cmpRational(a, parseRational("0.3")), 0);
  assert.equal(cmpRational(parseRational("2/3"), parseRational("0.6666")), 1);
  assert.equal(cmpRational(parseRational("-1/2"), parseRational("0")), -1);
});

test("midpoint lies strictly between distinct rationals", () => {
  const lo = parseRational("1/3");
  const hi = parseRational("1/2");
  const mid = midRational(lo, hi);
  assert.equal(cmpRational(lo, mid), -1);
  assert.equal(cmpRational(mid, hi), -1);
  assert.deepEqual(mid, { n: 5n, d: 12n });
});

test("formats in normal form", () => {
  assert.equal(formatRational(rational(6n, 4n)), "3/2");
  assert.equal(formatRational(rational(-5n, 1n)), "-5");
});
