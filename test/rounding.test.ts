import { test } from "node:test";
import assert from "node:assert/strict";
import { divRoundHalfEven } from "../src/pixel.js";
import { Frac, roundToGridHalfEven } from "../src/fraction.js";

test("divRoundHalfEven rounds halves to even", () => {
  assert.equal(divRoundHalfEven(5, 10), 0); // 0.5 -> 0 (even)
  assert.equal(divRoundHalfEven(15, 10), 2); // 1.5 -> 2 (even)
  assert.equal(divRoundHalfEven(25, 10), 2); // 2.5 -> 2 (even)
  assert.equal(divRoundHalfEven(35, 10), 4); // 3.5 -> 4 (even)
  assert.equal(divRoundHalfEven(45, 10), 4); // 4.5 -> 4 (even)
});

test("divRoundHalfEven rounds non-halves to nearest", () => {
  assert.equal(divRoundHalfEven(0, 7), 0);
  assert.equal(divRoundHalfEven(13, 10), 1);
  assert.equal(divRoundHalfEven(17, 10), 2);
  assert.equal(divRoundHalfEven(254, 255), 1);
  assert.equal(divRoundHalfEven(255 * 255, 255), 255);
  assert.equal(divRoundHalfEven(0, 1), 0);
});

test("divRoundHalfEven rejects invalid input", () => {
  assert.throws(() => divRoundHalfEven(1, 0), RangeError);
  assert.throws(() => divRoundHalfEven(-1, 10), RangeError);
  assert.throws(() => divRoundHalfEven(1.5, 10), RangeError);
});

test("Frac reduces and compares exactly", () => {
  const f = Frac.of(6n, 8n);
  assert.equal(f.n, 3n);
  assert.equal(f.d, 4n);
  assert.equal(Frac.of(1n, 2n).add(Frac.of(1n, 3n)).cmp(Frac.of(5n, 6n)), 0);
  assert.equal(Frac.of(1n, 2n).sub(Frac.of(2n, 3n)).cmp(Frac.of(-1n, 6n)), 0);
  assert.equal(Frac.of(2n, 3n).mul(Frac.of(3n, 4n)).cmp(Frac.of(1n, 2n)), 0);
});

test("roundToGridHalfEven matches half-even semantics on BigInt", () => {
  assert.equal(roundToGridHalfEven(Frac.of(1n, 4n), 2n), 0n); // 0.5 -> 0
  assert.equal(roundToGridHalfEven(Frac.of(3n, 4n), 2n), 2n); // 1.5 -> 2
  assert.equal(roundToGridHalfEven(Frac.of(5n, 4n), 2n), 2n); // 2.5 -> 2
  assert.equal(roundToGridHalfEven(Frac.of(-1n, 4n), 2n), 0n); // sign symmetric
  assert.equal(roundToGridHalfEven(Frac.of(-3n, 4n), 2n), -2n);
});
