import { test } from "node:test";
import { deepEqual, equal, ok } from "node:assert/strict";
import { integer, arrayOf } from "../src/arbitrary";
import { shrink, resumeShrink, ShrinkCheckpoint } from "../src/shrink";
import { hashValue } from "../src/hash";

const arb = arrayOf(integer(0, 100), { minLength: 0, maxLength: 10 });
const initial = [10, 20, 30, 40, 50];
const isInteresting = (v: number[]) => v.reduce((a, b) => a + b, 0) >= 30;

test("resuming from a checkpoint reaches the same minimal value", () => {
  const full = shrink(arb, isInteresting, initial);
  ok(full.complete);

  // session 1: budget exhausted part-way
  const part = shrink(arb, isInteresting, initial, { maxTests: 3 });
  ok(!part.complete);

  // session 2: resume from the JSON-round-tripped checkpoint
  const cpJson = JSON.parse(JSON.stringify(part.checkpoint)) as ShrinkCheckpoint<number[]>;
  const resumed = resumeShrink(arb, isInteresting, cpJson);
  ok(resumed.complete);
  deepEqual(resumed.minimal, full.minimal);
});

test("resumed sessions never re-test an already-tested candidate", () => {
  const part = shrink(arb, isInteresting, initial, { maxTests: 2 });
  const priorHashes = new Set(part.checkpoint.testedHashes);

  const retested: string[] = [];
  const spy = (v: number[]) => {
    const h = hashValue(v);
    if (priorHashes.has(h)) retested.push(h);
    return isInteresting(v);
  };
  const cpJson = JSON.parse(JSON.stringify(part.checkpoint)) as ShrinkCheckpoint<number[]>;
  const resumed = resumeShrink(arb, spy, cpJson);
  ok(resumed.complete);
  deepEqual(retested, [], "no candidate tested in session 1 may be re-tested");

  // the resumed trace marks previously tested candidates as skipped
  const skips = resumed.trace.filter((e) => e.outcome === "skip");
  ok(skips.length > 0, "expected skip entries for already-tested candidates");
});

test("union of both sessions covers exactly the uninterrupted run's tests", () => {
  const full = shrink(arb, isInteresting, initial);
  const part = shrink(arb, isInteresting, initial, { maxTests: 2 });
  const resumed = resumeShrink(
    arb,
    isInteresting,
    JSON.parse(JSON.stringify(part.checkpoint)),
  );
  equal(part.testsRun + resumed.testsRun, full.testsRun);
  deepEqual(
    [...resumed.checkpoint.testedHashes].sort(),
    [...full.checkpoint.testedHashes].sort(),
  );
});
