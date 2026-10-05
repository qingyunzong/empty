import { test } from "node:test";
import { equal, ok } from "node:assert/strict";
import { integer, arrayOf } from "../src/arbitrary";
import { shrink, ShrinkCheckpoint } from "../src/shrink";
import { assertSingleStepIrreducible } from "./helpers";

test("shrinks to the single-step irreducible value", () => {
  const arb = integer(0, 1000);
  const isInteresting = (v: number) => v >= 10;
  const result = shrink(arb, isInteresting, 937);
  equal(result.minimal, 10);
  ok(result.complete);
  assertSingleStepIrreducible(arb, result.minimal, isInteresting);
});

test("records an actual trace of every evaluated candidate", () => {
  const arb = arrayOf(integer(0, 50), { minLength: 0, maxLength: 10 });
  const isInteresting = (v: number[]) => v.reduce((a, b) => a + b, 0) >= 20;
  const result = shrink(arb, isInteresting, [10, 20, 30]);
  ok(result.trace.length > 0);
  const evaluated = result.trace.filter((e) => e.outcome !== "skip");
  equal(evaluated.length, result.testsRun);
  for (const e of result.trace) {
    ok(e.phase === "shrink");
    ok(["pass", "fail", "skip"].includes(e.outcome));
  }
  // every accepted move is recorded as a failing entry
  const fails = result.trace.filter((e) => e.outcome === "fail");
  equal(fails.length, result.steps);
});

test("emits a checkpoint after every accepted shrink step", () => {
  const arb = integer(0, 1000);
  const cps: ShrinkCheckpoint<number>[] = [];
  const result = shrink(arb, (v) => v >= 5, 400, {
    onCheckpoint: (cp) => cps.push(cp),
  });
  // one checkpoint per accepted step plus the final one
  equal(cps.length, result.steps + 1);
  for (let i = 0; i < cps.length - 1; i++) {
    equal(cps[i].steps, i + 1);
    ok(!cps[i].complete);
  }
  ok(cps[cps.length - 1].complete);
  equal(result.minimal, 5);
});

test("maxTests stops early with an incomplete, resumable checkpoint", () => {
  const arb = integer(0, 1000);
  const result = shrink(arb, (v) => v >= 5, 400, { maxTests: 1 });
  ok(!result.complete);
  ok(!result.checkpoint.complete);
  equal(result.testsRun, 1);
});
