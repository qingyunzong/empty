import { test } from "node:test";
import assert from "node:assert/strict";
import { JsonValue, parseProblem, ProblemSpec } from "../src/model.js";
import { analyze, findMinimumSize, selectRepresentatives } from "../src/solver.js";
import { verifyByEnumeration } from "../src/verify.js";
import { plan } from "../src/report.js";

function makeProblem(
  outputsByStrategy: Record<string, JsonValue[]>,
  sampleIds?: string[]
): ProblemSpec {
  const first = Object.values(outputsByStrategy)[0]!;
  const ids = sampleIds ?? first.map((_, i) => `T${i + 1}`);
  return {
    samples: ids.map((id) => ({ id })),
    strategies: Object.entries(outputsByStrategy).map(([id, outputs]) => ({ id, outputs })),
  };
}

test("selects the minimum samples distinguishing every pair", () => {
  const report = plan(makeProblem({ A: [1, 1, 1], B: [1, 2, 1], C: [1, 2, 3] }));
  assert.equal(report.selection.count, 2);
  assert.deepEqual(report.selection.sampleIds, ["T2", "T3"]);
  assert.equal(report.equivalentPairs.length, 0);
  assert.equal(report.verification.status, "confirmed");
  assert.equal(report.verification.enumeratedMinimumSize, 2);
});

test("reports equivalent strategies with identical-output evidence", () => {
  const report = plan(makeProblem({ A: [1, 2], B: [1, 2], C: [9, 9] }));
  assert.equal(report.equivalentPairs.length, 1);
  const pair = report.equivalentPairs[0]!;
  assert.deepEqual(pair.strategies, ["A", "B"]);
  assert.deepEqual(pair.evidence.sharedOutputs, [1, 2]);
  assert.match(pair.evidence.reason, /identical outputs on all 2 candidate samples/);
  assert.equal(report.selection.count, 1);
  assert.deepEqual(report.selection.sampleIds, ["T1"]);
});

test("never selects samples that distinguish nothing", () => {
  const report = plan(makeProblem({ A: [1, 5, 1], B: [2, 5, 2] }));
  assert.deepEqual(report.summary.uselessSampleIds, ["T2"]);
  assert.deepEqual(report.selection.sampleIds, ["T1"]);
});

test("collapses interchangeable samples and picks the smallest id", () => {
  const report = plan(makeProblem({ A: [1, 1, 1], B: [2, 2, 1] }));
  assert.deepEqual(report.summary.interchangeableSampleGroups, [["T1", "T2"]]);
  assert.equal(report.selection.count, 1);
  assert.deepEqual(report.selection.sampleIds, ["T1"]);
});

test("returns an empty selection when every strategy is equivalent", () => {
  const report = plan(makeProblem({ A: [1, 2], B: [1, 2] }));
  assert.equal(report.selection.count, 0);
  assert.deepEqual(report.selection.sampleIds, []);
  assert.equal(report.equivalentPairs.length, 1);
  assert.equal(report.verification.status, "confirmed");
});

test("handles structured (nested) outputs via deep equality", () => {
  const report = plan(
    makeProblem({
      A: [{ x: [1, 2] }, "same"],
      B: [{ x: [1, 2] }, "different"],
      C: [{ x: [1, 9] }, "same"],
    })
  );
  assert.equal(report.selection.count, 2);
  assert.deepEqual(report.selection.sampleIds, ["T1", "T2"]);
  assert.equal(report.equivalentPairs.length, 0);
});

test("selected ids are sorted lexicographically", () => {
  const problem = makeProblem(
    { A: [1, 1, 1], B: [2, 1, 1], C: [1, 2, 1], D: [1, 1, 2] },
    ["zeta", "alpha", "mid"]
  );
  const report = plan(problem);
  const sorted = [...report.selection.sampleIds].sort();
  assert.deepEqual(report.selection.sampleIds, sorted);
});

function mulberry32(seed: number): () => number {
  let state = seed;
  return () => {
    state |= 0;
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

test("exact solver matches independent enumeration on 300 random instances", () => {
  const random = mulberry32(20261005);
  for (let trial = 0; trial < 300; trial += 1) {
    const strategyCount = 2 + Math.floor(random() * 5); // 2..6
    const sampleCount = 1 + Math.floor(random() * 10); // 1..10
    const outputs: Record<string, JsonValue[]> = {};
    for (let s = 0; s < strategyCount; s += 1) {
      outputs[`S${s}`] = Array.from({ length: sampleCount }, () =>
        Math.floor(random() * 3)
      );
    }
    const problem = makeProblem(outputs);
    const analysis = analyze(problem);
    const claimed = findMinimumSize(analysis.columns, analysis.fullMask);
    const check = verifyByEnumeration(
      analysis.columns.map((c) => c.pairMask),
      analysis.fullMask,
      claimed,
      1_000_000
    );
    assert.equal(
      check.status,
      "confirmed",
      `trial ${trial}: ${JSON.stringify(check)}`
    );
    const selected = selectRepresentatives(analysis.columns, claimed, analysis.fullMask);
    assert.equal(selected.length, claimed);
  }
});

test("verifier flags a wrong claim as mismatch", () => {
  const analysis = analyze(makeProblem({ A: [1, 1, 1], B: [1, 2, 1], C: [1, 2, 3] }));
  const check = verifyByEnumeration(
    analysis.columns.map((c) => c.pairMask),
    analysis.fullMask,
    3 // true minimum is 2
  );
  assert.equal(check.status, "mismatch");
  assert.equal(check.enumeratedMinimumSize, 2);
});

test("verifier reports inconclusive when the combination budget runs out", () => {
  const analysis = analyze(makeProblem({ A: [1, 1, 1], B: [1, 2, 1], C: [1, 2, 3] }));
  const check = verifyByEnumeration(
    analysis.columns.map((c) => c.pairMask),
    analysis.fullMask,
    2,
    1 // budget of a single combination
  );
  assert.equal(check.status, "inconclusive");
});

test("enforces the 20-strategy and 30-sample limits", () => {
  const strategies = Array.from({ length: 21 }, (_, i) => ({
    id: `S${i}`,
    outputs: [i],
  }));
  assert.throws(
    () => parseProblem({ samples: [{ id: "T1" }], strategies }),
    /too many strategies: 21 \(maximum 20\)/
  );
  const samples = Array.from({ length: 31 }, (_, i) => ({ id: `T${i}` }));
  assert.throws(
    () => parseProblem({ samples, strategies: [{ id: "S", outputs: samples.map(() => 0) }] }),
    /too many samples: 31 \(maximum 30\)/
  );
});

test("accepts exactly 20 strategies and 30 samples", () => {
  const samples = Array.from({ length: 30 }, (_, i) => ({ id: `T${i}` }));
  const strategies = Array.from({ length: 20 }, (_, i) => ({
    id: `S${i}`,
    outputs: samples.map((_, k) => (k === i ? 1 : 0)),
  }));
  const problem = parseProblem({ samples, strategies });
  const report = plan(problem);
  assert.equal(report.selection.count, 19);
  assert.equal(report.verification.status, "confirmed");
});

test("rejects malformed input", () => {
  assert.throws(() => parseProblem(null), /must be a JSON object/);
  assert.throws(
    () => parseProblem({ samples: [{ id: "T1" }], strategies: [] }),
    /"strategies" must be a non-empty array/
  );
  assert.throws(
    () =>
      parseProblem({
        samples: [{ id: "T1" }, { id: "T1" }],
        strategies: [{ id: "S", outputs: [1, 2] }],
      }),
    /duplicate sample id/
  );
  assert.throws(
    () =>
      parseProblem({
        samples: [{ id: "T1" }],
        strategies: [
          { id: "S", outputs: [1] },
          { id: "S", outputs: [2] },
        ],
      }),
    /duplicate strategy id/
  );
  assert.throws(
    () =>
      parseProblem({
        samples: [{ id: "T1" }, { id: "T2" }],
        strategies: [{ id: "S", outputs: [1] }],
      }),
    /has 1 outputs, expected 2/
  );
});
