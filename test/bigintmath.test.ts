import test from "node:test";
import assert from "node:assert/strict";
import {
  ceilDiv,
  egcd,
  floorDiv,
  floorMod,
  gcd,
  modInverse,
} from "../src/bigintmath.js";

test("floorDiv rounds toward -infinity", () => {
  const cases: Array<[bigint, bigint, bigint]> = [
    [7n, 2n, 3n],
    [-7n, 2n, -4n],
    [7n, -2n, -4n],
    [-7n, -2n, 3n],
    [6n, 3n, 2n],
    [-6n, 3n, -2n],
    [0n, 5n, 0n],
    [1n, 3n, 0n],
    [-1n, 3n, -1n],
  ];
  for (const [a, b, expected] of cases) assert.equal(floorDiv(a, b), expected, `${a}/${b}`);
});

test("ceilDiv rounds toward +infinity", () => {
  const cases: Array<[bigint, bigint, bigint]> = [
    [7n, 2n, 4n],
    [-7n, 2n, -3n],
    [7n, -2n, -3n],
    [-7n, -2n, 4n],
    [6n, 3n, 2n],
    [-3n, -2n, 2n],
    [0n, 5n, 0n],
  ];
  for (const [a, b, expected] of cases) assert.equal(ceilDiv(a, b), expected, `${a}/${b}`);
});

test("floorMod always returns a value in [0, m)", () => {
  assert.equal(floorMod(10n, 3n), 1n);
  assert.equal(floorMod(-10n, 3n), 2n);
  assert.equal(floorMod(0n, 7n), 0n);
  assert.equal(floorMod(-(1n << 63n), 7n), floorMod(-(1n << 63n) + 7n * (1n << 60n), 7n));
});

test("gcd and egcd satisfy a*x + b*y = gcd", () => {
  const pairs: Array<[bigint, bigint]> = [
    [12n, 18n],
    [-12n, 18n],
    [0n, 5n],
    [0n, 0n],
    [9223372036854775807n, 12297829382473034410n],
  ];
  for (const [a, b] of pairs) {
    const { g, x, y } = egcd(a, b);
    assert.equal(g, gcd(a, b));
    assert.equal(a * x + b * y, g);
    assert.ok(g >= 0n);
  }
});

test("modInverse computes the inverse when it exists", () => {
  assert.equal(modInverse(3n, 7n), 5n);
  assert.equal(modInverse(2n, 4n), null);
  assert.equal(modInverse(0n, 1n), 0n);
  const a = 123456789012345678n;
  const m = 9223372036854775783n; // prime
  const inv = modInverse(a, m);
  assert.ok(inv !== null);
  assert.equal((a * inv!) % m, 1n);
});
