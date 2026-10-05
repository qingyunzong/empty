import test from "node:test";
import assert from "node:assert/strict";
import { parseProblem } from "../src/model";
import { buildDistinguishData, minimumCoverSize } from "../src/solver";
import { verifyByEnumeration } from "../src/verify";
import { bruteForceOptimum, mulberry32, randomProblemRaw } from "./helpers";

const BUDGET = 50_000_000;

test("enumeration confirms the solver optimum on randomized problems", () => {
  const rng = mulberry32(424242);
  for (let trial = 0; trial < 40; trial++) {
    const strategyCount = 2 + Math.floor(rng() * 7);
    const sampleCount = 1 + Math.floor(rng() * 11);
    const alphabet = 2 + Math.floor(rng() * 3);
    const problem = parseProblem(randomProblemRaw(rng, strategyCount, sampleCount, alphabet));
    const data = buildDistinguishData(problem);
    const brute = bruteForceOptimum(problem);
    const optimum = minimumCoverSize(data);

    const result = verifyByEnumeration(data.sampleCover, data.fullCover, optimum, BUDGET);
    assert.ok(result.confirmed, `not confirmed on trial ${trial}`);
    assert.equal(result.counterexample, null);
    assert.equal(result.optimalCount, brute.count, `optimal count mismatch on trial ${trial}`);
    assert.equal(result.maxSizeExhausted, optimum - 1);
    assert.ok(!result.budgetExhausted);
  }
});

test("enumeration exposes a counterexample when given a wrong optimum", () => {
  const problem = parseProblem({
    samples: ["s1", "s2", "s3"],
    strategies: [
      { id: "A", outputs: [1, 1, 1] },
      { id: "B", outputs: [2, 1, 1] },
      { id: "C", outputs: [1, 2, 3] },
    ],
  });
  const data = buildDistinguishData(problem);
  const optimum = minimumCoverSize(data);
  assert.equal(optimum, 2);
  const result = verifyByEnumeration(data.sampleCover, data.fullCover, optimum + 1, BUDGET);
  assert.ok(!result.confirmed);
  assert.ok(result.counterexample !== null);
  assert.equal(result.counterexample!.length, optimum);
});

test("node budget stops enumeration and reports it", () => {
  const problem = parseProblem({
    samples: ["s1", "s2", "s3", "s4"],
    strategies: [
      { id: "A", outputs: [1, 1, 1, 1] },
      { id: "B", outputs: [2, 2, 2, 2] },
    ],
  });
  const data = buildDistinguishData(problem);
  const result = verifyByEnumeration(data.sampleCover, data.fullCover, 1, 1);
  assert.ok(result.budgetExhausted);
  assert.ok(!result.confirmed);
});

test("all-equivalent strategies need zero samples and confirm trivially", () => {
  const problem = parseProblem({
    samples: ["s1", "s2"],
    strategies: [
      { id: "A", outputs: [1, 2] },
      { id: "B", outputs: [1, 2] },
    ],
  });
  const data = buildDistinguishData(problem);
  assert.equal(data.fullCover, 0n);
  const result = verifyByEnumeration(data.sampleCover, data.fullCover, 0, BUDGET);
  assert.ok(result.confirmed);
  assert.equal(result.optimalCount, 1);
});
