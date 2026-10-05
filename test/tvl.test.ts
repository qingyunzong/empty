import { test } from "node:test";
import assert from "node:assert/strict";
import { T, F, U, tvlAnd, tvlOr, tvlNot, tvlOfBool, type TVL } from "../src/tvl.js";

const VALUES: TVL[] = [T, F, U];

// Kleene strong three-valued logic truth tables.
const AND_TABLE: Record<TVL, Record<TVL, TVL>> = {
  true: { true: T, false: F, unknown: U },
  false: { true: F, false: F, unknown: F },
  unknown: { true: U, false: F, unknown: U },
};
const OR_TABLE: Record<TVL, Record<TVL, TVL>> = {
  true: { true: T, false: T, unknown: T },
  false: { true: T, false: F, unknown: U },
  unknown: { true: T, false: U, unknown: U },
};

test("and/or match the full Kleene truth tables", () => {
  for (const a of VALUES) {
    for (const b of VALUES) {
      assert.equal(tvlAnd(a, b), AND_TABLE[a][b], `and(${a},${b})`);
      assert.equal(tvlOr(a, b), OR_TABLE[a][b], `or(${a},${b})`);
    }
  }
});

test("not flips definite values and keeps unknown", () => {
  assert.equal(tvlNot(T), F);
  assert.equal(tvlNot(F), T);
  assert.equal(tvlNot(U), U);
});

test("variadic and/or short-circuit on dominating values", () => {
  assert.equal(tvlAnd(T, T, T), T);
  assert.equal(tvlAnd(T, U, T), U);
  assert.equal(tvlAnd(T, F, U), F);
  assert.equal(tvlOr(F, F, F), F);
  assert.equal(tvlOr(F, U, F), U);
  assert.equal(tvlOr(F, T, U), T);
  assert.equal(tvlAnd(), T);
  assert.equal(tvlOr(), F);
});

test("tvlOfBool lifts booleans", () => {
  assert.equal(tvlOfBool(true), T);
  assert.equal(tvlOfBool(false), F);
});
