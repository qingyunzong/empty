import { test } from "node:test";
import assert from "node:assert/strict";
import {
  add, cmp, div, eq, floorDiv, mod, mul, rat, scale, sign, sub, toNumber,
} from "../src/rational.js";
import { mulberry32, randomRational } from "./helpers.js";

test("normal form: reduced, positive denominator, canonical zero", () => {
  assert.deepEqual(rat(2, 4), { n: 1n, d: 2n });
  assert.deepEqual(rat(3, -4), { n: -3n, d: 4n });
  assert.deepEqual(rat(-6, -8), { n: 3n, d: 4n });
  assert.deepEqual(rat(0, 7), { n: 0n, d: 1n });
  assert.throws(() => rat(1, 0));
});

test("arithmetic on exact thirds and sevenths", () => {
  const third = rat(1, 3);
  const seventh = rat(1, 7);
  assert.ok(eq(add(third, third), rat(2, 3)));
  assert.ok(eq(mul(third, seventh), rat(1, 21)));
  assert.ok(eq(sub(rat(1, 2), third), rat(1, 6)));
  assert.ok(eq(div(third, seventh), rat(7, 3)));
  assert.ok(eq(scale(third, 3n), rat(1)));
});

test("floorDiv/mod identity incl. negatives", () => {
  const cases = [
    [rat(7, 2), rat(2)],
    [rat(-7, 2), rat(2)],
    [rat(-1, 3), rat(1, 5)],
    [rat(1, 3), rat(1, 7)],
    [rat(4), rat(2)],
  ] as const;
  for (const [a, b] of cases) {
    const q = floorDiv(a, b);
    const r = mod(a, b);
    // a == b*q + r
    assert.ok(eq(a, add(scale(b, q), r)), `identity for ${a.n}/${a.d} mod ${b.n}/${b.d}`);
    // 0 <= r < b (divisors in the cases above are positive)
    assert.ok(sign(r) >= 0 && cmp(r, b) < 0);
  }
  assert.equal(floorDiv(rat(-7, 2), rat(2)), -2n);
  assert.equal(floorDiv(rat(7, 2), rat(2)), 1n);
  assert.equal(floorDiv(rat(7, 2), rat(-2)), -2n); // floor, not truncation
  assert.throws(() => mod(rat(1), rat(-1)));
});

test("random rationals: field identities and cmp/toNumber consistency", () => {
  const rnd = mulberry32(42);
  for (let i = 0; i < 500; i++) {
    const a = randomRational(rnd, 1000, 50);
    const b = randomRational(rnd, 1000, 50);
    assert.ok(eq(sub(add(a, b), b), a));
    assert.ok(eq(add(a, b), add(b, a)));
    if (b.n !== 0n) assert.ok(eq(mul(div(a, b), b), a));
    const c = cmp(a, b);
    const approx = toNumber(a) - toNumber(b);
    if (c === 0) assert.equal(approx, 0);
    else assert.equal(Math.sign(approx), c);
  }
});
