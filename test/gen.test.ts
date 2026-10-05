import { test } from "node:test";
import { ok, equal } from "node:assert/strict";
import {
  integer,
  arrayOf,
  sortedArrayOf,
  treeOf,
  suchThat,
  TreeNode,
} from "../src/arbitrary";
import { Rng, seedFromString } from "../src/rng";

const rng = () => new Rng(seedFromString("gen-tests"));

test("integer generates within bounds and shrinks within bounds", () => {
  const arb = integer(-5, 7);
  for (let i = 0; i < 200; i++) {
    const v = arb.generate(rng(), 10);
    ok(v >= -5 && v <= 7 && Number.isInteger(v));
    for (const s of arb.shrink(v)) {
      ok(s >= -5 && s <= 7, `shrink ${s} of ${v} out of bounds`);
    }
  }
});

test("integer shrinks toward the in-range target", () => {
  deep: {
    const shrinks = integer(0, 100).shrink(37);
    equal(shrinks[0], 0);
    ok(shrinks.every((s) => s >= 0 && s < 37));
  }
  // negative-only range shrinks toward min
  const neg = integer(-10, -3);
  equal(neg.shrink(-4)[0], -10);
});

test("arrayOf respects length contract in generation and shrinking", () => {
  const arb = arrayOf(integer(0, 9), { minLength: 2, maxLength: 6 });
  for (let i = 0; i < 100; i++) {
    const v = arb.generate(rng(), 10);
    ok(v.length >= 2 && v.length <= 6);
    for (const s of arb.shrink(v)) {
      ok(s.length >= 2, `shrink to length ${s.length} violates minLength`);
      ok(arb.contract(s));
    }
  }
});

test("sortedArrayOf keeps the ordering contract while shrinking", () => {
  const arb = sortedArrayOf(integer(0, 20), { minLength: 1, maxLength: 8 });
  const isSorted = (a: number[]) => a.every((x, i) => i === 0 || a[i - 1] <= x);
  for (let i = 0; i < 100; i++) {
    const v = arb.generate(rng(), 8);
    ok(isSorted(v));
    for (const s of arb.shrink(v)) ok(isSorted(s), `unsorted shrink ${s}`);
  }
});

test("treeOf respects depth/branch bounds in generation and shrinking", () => {
  const arb = treeOf(integer(0, 5), { maxDepth: 3, maxBranch: 2 });
  const depth = (n: TreeNode<number>): number =>
    1 + (n.children.length ? Math.max(...n.children.map(depth)) : 0);
  for (let i = 0; i < 100; i++) {
    const v = arb.generate(rng(), 6);
    ok(depth(v) <= 3);
    ok(arb.contract(v));
    for (const s of arb.shrink(v)) {
      ok(arb.contract(s), `tree shrink violates contract: ${JSON.stringify(s)}`);
    }
  }
});

test("suchThat filters generation and shrinking through the predicate", () => {
  const even = (a: number[]) => a.every((x) => x % 2 === 0);
  const arb = suchThat(arrayOf(integer(0, 9), { maxLength: 6 }), even);
  for (let i = 0; i < 50; i++) {
    const v = arb.generate(rng(), 6);
    ok(even(v));
    for (const s of arb.shrink(v)) ok(even(s), `odd element in shrink ${s}`);
  }
});
