import test from "node:test";
import * as assert from "node:assert/strict";
import { Rng } from "../src/rng";
import { Gen, integer, arrayOf } from "../src/gen";
import { shrink, ShrinkResult } from "../src/shrink";

function shrinkFirstFailing<T>(
  gen: Gen<T>,
  fails: (v: T) => boolean,
  seed: number
): ShrinkResult<T> {
  const rng = new Rng(seed);
  for (let size = 0; size < 1000; size++) {
    const tree = gen(rng, size);
    if (fails(tree.value)) return shrink(tree, fails);
  }
  throw new Error("no failing case found");
}

test("shrinks to the true minimum that still fails", () => {
  const fails = (n: number) => n >= 5;
  const result = shrinkFirstFailing(integer(0, 100), fails, 1);
  assert.equal(result.minimal, 5);
});

test("every accepted trace step genuinely fails; rejected ones do not", () => {
  const fails = (n: number) => n >= 5;
  const result = shrinkFirstFailing(integer(0, 100), fails, 2);
  assert.ok(result.trace.length > 0);
  for (const step of result.trace) {
    const candidate = step.candidate as number;
    assert.equal(
      step.accepted,
      fails(candidate),
      `trace step ${candidate} acceptance mismatch`
    );
  }
  // The minimal value fails, and anything smaller accepted nowhere.
  assert.ok(fails(result.minimal));
  assert.ok(result.acceptedPath.length > 0);
});

test("non-monotonic property: passing candidates are never accepted", () => {
  // Fails only for even numbers >= 10. A naive shrinker that accepts
  // candidates without re-checking could land on an odd number.
  const fails = (n: number) => n >= 10 && n % 2 === 0;
  const result = shrinkFirstFailing(integer(0, 60), fails, 3);
  assert.ok(fails(result.minimal), `minimal ${result.minimal} must genuinely fail`);
  assert.equal(result.minimal, 10);
  for (const step of result.trace) {
    if (step.accepted) assert.ok(fails(step.candidate as number));
  }
});

test("arrays shrink towards shorter, smaller-element counterexamples", () => {
  // Fails when the array contains a value >= 3.
  const fails = (xs: number[]) => xs.some((x) => x >= 3);
  const result = shrinkFirstFailing(arrayOf(integer(0, 20), { maxLength: 8 }), fails, 4);
  assert.ok(fails(result.minimal));
  assert.deepEqual(result.minimal, [3]);
});

test("shrinking terminates and re-runs the property a bounded number of times", () => {
  const fails = (n: number) => n > 0;
  let calls = 0;
  const counting = (n: number) => {
    calls++;
    return fails(n);
  };
  const rng = new Rng(9);
  const tree = integer(0, 1000)(rng, 0);
  const result = shrink(tree, counting);
  assert.equal(result.minimal, 1);
  assert.equal(result.attempts, result.trace.length);
  assert.ok(calls <= 100, `too many shrink attempts: ${calls}`);
});
