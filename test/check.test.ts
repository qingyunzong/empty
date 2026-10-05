import { test } from "node:test";
import { deepEqual, equal, ok } from "node:assert/strict";
import { check } from "../src/check";
import { integer, arrayOf, sortedArrayOf } from "../src/arbitrary";
import { assertSingleStepIrreducible } from "./helpers";

test("passing property yields status passed with a full trace", () => {
  const arb = arrayOf(integer(0, 9), { maxLength: 5 });
  const report = check(arb, () => true, { seed: "pass-seed", numRuns: 25 });
  equal(report.status, "passed");
  equal(report.trace.length, 25);
  ok(report.trace.every((e) => e.phase === "generate" && e.outcome === "pass"));
});

test("returning false falsifies; the minimal value is single-step irreducible", () => {
  const arb = arrayOf(integer(0, 10), { maxLength: 6 });
  const property = (v: number[]) => v.reduce((a, b) => a + b, 0) < 15;
  const report = check(arb, property, { seed: "falsify-seed", numRuns: 100 });
  equal(report.status, "falsified");
  ok(report.counterexample !== undefined);
  ok(report.minimal !== undefined);
  ok(report.shrinkComplete);
  const isInteresting = (v: number[]) => property(v) === false;
  ok(isInteresting(report.minimal!));
  assertSingleStepIrreducible(arb, report.minimal!, isInteresting);
  // trace covers generation and shrink phases with real outcomes
  ok(report.trace.some((e) => e.phase === "shrink" && e.outcome === "fail"));
});

test("throwing is reported as error, distinctly from falsification", () => {
  const arb = arrayOf(integer(0, 10), { maxLength: 6 });
  const boom = (v: number[]) => {
    if (v.length >= 3) throw new Error("property blew up");
    return true;
  };
  const report = check(arb, boom, { seed: "error-seed", numRuns: 100 });
  equal(report.status, "error");
  equal(report.error?.message, "property blew up");
  ok(report.minimal !== undefined);
  // an exception is not a falsification: no 'fail' outcomes in the trace
  ok(!report.trace.some((e) => e.outcome === "fail"));
  ok(report.trace.some((e) => e.outcome === "error"));
});

test("same seed reproduces the same counterexample and minimal value", () => {
  const arb = arrayOf(integer(0, 10), { maxLength: 6 });
  const property = (v: number[]) => v.reduce((a, b) => a + b, 0) < 15;
  const a = check(arb, property, { seed: "repro-seed", numRuns: 100 });
  const b = check(arb, property, { seed: "repro-seed", numRuns: 100 });
  equal(a.status, "falsified");
  deepEqual(a.counterexample, b.counterexample);
  deepEqual(a.minimal, b.minimal);
});

test("shrinking preserves the input contract (sorted arrays)", () => {
  const arb = sortedArrayOf(integer(0, 20), { minLength: 1, maxLength: 8 });
  const isSorted = (a: number[]) => a.every((x, i) => i === 0 || a[i - 1] <= x);
  const property = (v: number[]) => v.reduce((a, b) => a + b, 0) <= 10;
  const report = check(arb, property, { seed: "contract-seed", numRuns: 200 });
  equal(report.status, "falsified");
  const shrinkEntries = report.trace.filter((e) => e.phase === "shrink");
  ok(shrinkEntries.length > 0);
  for (const e of shrinkEntries) {
    ok(
      isSorted(e.value as number[]),
      `shrink-phase candidate violates contract: ${JSON.stringify(e.value)}`,
    );
  }
  ok(isSorted(report.minimal!));
  assertSingleStepIrreducible(arb, report.minimal!, (v) => property(v) === false);
});
