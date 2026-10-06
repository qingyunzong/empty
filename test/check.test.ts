import { test } from "node:test";
import * as assert from "node:assert/strict";
import { mkdtempSync, readdirSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { check, replay, PropertyFailure } from "../src/check.js";
import type { FailureRecord } from "../src/check.js";
import { integer, arrayOf } from "../src/gen.js";
import { Rng, deriveSeed } from "../src/rng.js";

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), "pbt-"));
}

function catchFailure(fn: () => unknown): PropertyFailure {
  try {
    fn();
  } catch (err) {
    if (err instanceof PropertyFailure) return err;
    throw err;
  }
  throw new Error("expected PropertyFailure");
}

test("passing property reports ok with run and small-case counts", () => {
  const dir = tempDir();
  const result = check((n: number) => n <= 100, integer(0, 100), {
    runs: 50,
    testName: "always-true",
    failureDir: dir,
  });
  assert.equal(result.ok, true);
  assert.equal(result.runs, 50);
  assert.ok(result.smallCases > 0);
  assert.equal(readdirSync(dir).length, 0); // no failure records written
});

test("each test gets an independent random state, regardless of execution order", () => {
  // Generate the value of iteration 0 for two tests in both orders.
  const valueFor = (testName: string): number => {
    const testSeed = deriveSeed(1n, testName);
    return integer(0, 1_000_000).generate(new Rng(deriveSeed(testSeed, 0)));
  };
  const aFirst = valueFor("test-a");
  const bFirst = valueFor("test-b");
  const bSecond = valueFor("test-b");
  const aSecond = valueFor("test-a");
  assert.equal(aFirst, aSecond);
  assert.equal(bFirst, bSecond);
  assert.notEqual(aFirst, bFirst);
});

test("failing property persists generation params and shrink trace", () => {
  const dir = tempDir();
  const failure = catchFailure(() =>
    // Small cases (0, 100, 1, 99) all pass; only random draws can fail.
    check((n: number) => n % 7 !== 3, integer(0, 100), {
      runs: 200,
      seed: 1234n,
      testName: "lt-90",
      failureDir: dir,
    }),
  );
  const record = failure.record;
  assert.equal(record.testName, "lt-90");
  assert.equal(record.seed, "1234");
  assert.equal(record.kind, "random");
  assert.ok(record.iteration >= 0);
  assert.ok(record.shrinkTrace.length > 0);
  assert.ok(existsSync(record.file));
  const onDisk = JSON.parse(readFileSync(record.file, "utf8")) as FailureRecord;
  assert.deepEqual(onDisk.counterexample, record.counterexample);
  assert.deepEqual(onDisk.shrinkTrace, record.shrinkTrace);
});

test("shrinking accepts only genuine failures and reaches the minimum", () => {
  const dir = tempDir();
  const prop = (n: number): boolean => n < 5;
  const failure = catchFailure(() =>
    check(prop, integer(0, 1000), {
      runs: 500,
      seed: 77n,
      testName: "shrink-to-5",
      failureDir: dir,
    }),
  );
  const record = failure.record;
  // Minimal counterexample for n < 5 over integers is exactly 5.
  assert.equal(record.counterexample, 5);
  // Every accepted trace step genuinely fails the property...
  for (const step of record.shrinkTrace) {
    assert.equal(step.accepted, !prop(step.candidate as number));
  }
  // ...and every accepted step is strictly smaller than the previous one.
  const accepted = record.shrinkTrace
    .filter((s) => s.accepted)
    .map((s) => s.candidate as number);
  for (let i = 1; i < accepted.length; i++) {
    assert.ok(accepted[i] < accepted[i - 1]);
  }
});

test("final counterexample is replay-confirmed to still fail", () => {
  const dir = tempDir();
  const failure = catchFailure(() =>
    check((xs: number[]) => xs.reduce((a, b) => a + b, 0) < 20,
      arrayOf(integer(0, 30), { minLength: 1, maxLength: 6 }),
      { runs: 300, seed: 9n, testName: "sum-lt-20", failureDir: dir }),
  );
  assert.equal(failure.record.replayConfirmed, true);
  const xs = failure.record.counterexample as number[];
  assert.ok(xs.reduce((a, b) => a + b, 0) >= 20);
});

test("fixed small cases run before any random case", () => {
  const dir = tempDir();
  // Fails on the very first small case (0), so no random iteration runs.
  const failure = catchFailure(() =>
    check((n: number) => n !== 0, integer(0, 100), {
      runs: 100,
      testName: "small-first",
      failureDir: dir,
    }),
  );
  assert.equal(failure.record.kind, "small");
  assert.equal(failure.record.iteration, -1);
  assert.equal(failure.record.smallIndex, 0);
  assert.equal(failure.record.counterexample, 0);
});

test("replay regenerates the original value and confirms the failure", () => {
  const dir = tempDir();
  const gen = integer(0, 1000);
  const prop = (n: number): boolean => n < 42;
  const failure = catchFailure(() =>
    check(prop, gen, { runs: 500, seed: 31337n, testName: "replay-me", failureDir: dir }),
  );
  const result = replay(failure.record, gen, prop);
  assert.equal(result.originalReproduced, true);
  assert.equal(result.originalFails, true);
  assert.equal(result.counterexampleFails, true);
  assert.equal(failure.record.counterexample, 42);
});

test("non-deterministic property is rejected at replay confirmation", () => {
  const dir = tempDir();
  let calls = 0;
  // Fails exactly once, then passes: replay must detect unsoundness.
  const flaky = (): boolean => ++calls !== 1;
  let message = "";
  try {
    check(flaky, integer(0, 10), { runs: 1, testName: "flaky", failureDir: dir });
  } catch (err) {
    message = String(err);
  }
  assert.match(message, /non-deterministic/);
});
