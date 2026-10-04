import { test } from "node:test";
import * as assert from "node:assert/strict";
import { roundHalfEven, roundHalfEvenBig } from "../src/rounding.js";

test("round-half-even: exact quarters on denominator 4", () => {
  const cases: Array<[number, number]> = [
    [0, 0], [1, 0], [2, 0],  // 0.00, 0.25, 0.50 -> tie to even 0
    [3, 1], [4, 1], [5, 1],  // 0.75, 1.00, 1.25
    [6, 2],                  // 1.50 -> tie to even 2
    [7, 2], [8, 2], [9, 2],  // 1.75, 2.00, 2.25
    [10, 2],                 // 2.50 -> tie to even 2
    [11, 3], [13, 3], [14, 4], // 2.75, 3.25, 3.50 -> tie to even 4
  ];
  for (const [num, expected] of cases) {
    assert.equal(roundHalfEven(num, 4), expected, `${num}/4`);
  }
});

test("round-half-even: halves and thirds", () => {
  assert.equal(roundHalfEven(1, 2), 0);  // 0.5 -> even 0
  assert.equal(roundHalfEven(3, 2), 2);  // 1.5 -> even 2
  assert.equal(roundHalfEven(5, 2), 2);  // 2.5 -> even 2
  assert.equal(roundHalfEven(7, 2), 4);  // 3.5 -> even 4
  assert.equal(roundHalfEven(1, 3), 0);
  assert.equal(roundHalfEven(2, 3), 1);
  assert.equal(roundHalfEven(4, 3), 1);
  assert.equal(roundHalfEven(5, 3), 2);
});

test("round-half-even: BigInt twin agrees on an exhaustive sweep", () => {
  for (let den = 1; den <= 17; den++) {
    for (let num = 0; num <= 40 * den; num++) {
      assert.equal(
        roundHalfEvenBig(BigInt(num), BigInt(den)),
        BigInt(roundHalfEven(num, den)),
        `${num}/${den}`,
      );
    }
  }
});

test("round-half-even: rejects invalid input", () => {
  assert.throws(() => roundHalfEven(-1, 4));
  assert.throws(() => roundHalfEven(1, 0));
  assert.throws(() => roundHalfEven(1.5, 4));
});
