import { test } from "node:test";
import * as assert from "node:assert/strict";
import { Rng } from "../src/rng.js";
import { integer, arrayOf, lowercaseString, tuple, filter } from "../src/gen.js";

test("integer generates within range", () => {
  const gen = integer(3, 9);
  const rng = new Rng(0n);
  for (let i = 0; i < 500; i++) {
    const v = gen.generate(rng);
    assert.ok(v >= 3 && v <= 9);
  }
});

test("integer shrink candidates stay in range and move toward target", () => {
  const gen = integer(0, 100);
  const candidates = [...gen.shrink(80)];
  assert.ok(candidates.length > 0);
  assert.equal(candidates[0], 0);
  for (const c of candidates) {
    assert.ok(c >= 0 && c <= 100);
    assert.ok(Math.abs(c) < Math.abs(80));
  }
});

test("integer smalls are fixed edge cases", () => {
  assert.deepEqual(integer(0, 10).smalls(), [0, 10, 1, 9]);
  assert.deepEqual(integer(5, 8).smalls(), [5, 8, 6, 7]);
});

test("array shrink produces shorter arrays then smaller elements", () => {
  const gen = arrayOf(integer(0, 100), { minLength: 0, maxLength: 10 });
  const candidates = [...gen.shrink([50, 60, 70, 80])];
  assert.deepEqual(candidates[0], [50, 60]); // drop half first
  assert.ok(candidates.some((c) => c.length === 0));
  assert.ok(candidates.some((c) => c.length === 4 && c[0] === 0));
});

test("filtered generator only yields and shrinks to satisfying values", () => {
  const gen = filter(integer(0, 50), (n) => n % 2 === 0);
  const rng = new Rng(5n);
  for (let i = 0; i < 100; i++) assert.equal(gen.generate(rng) % 2, 0);
  for (const c of gen.shrink(20)) assert.equal(c % 2, 0);
});

test("tuple and string generators work", () => {
  const gen = tuple(integer(0, 5), lowercaseString({ maxLength: 3 }));
  const rng = new Rng(9n);
  const [n, s] = gen.generate(rng);
  assert.ok(n >= 0 && n <= 5);
  assert.ok(s.length <= 3);
  assert.deepEqual(gen.smalls().length, 1);
});
