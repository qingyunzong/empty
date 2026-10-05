import test from "node:test";
import assert from "node:assert/strict";
import { parseProblem } from "../src/model";
import { buildDistinguishData, firstFeasibleOfSize, minimumCoverSize } from "../src/solver";
import { bruteForceOptimum, mulberry32, randomProblemRaw } from "./helpers";

test("buildDistinguishData finds required and equivalent pairs", () => {
  const problem = parseProblem({
    samples: ["s1", "s2", "s3"],
    strategies: [
      { id: "A", outputs: [1, 1, 1] },
      { id: "B", outputs: [1, 2, 1] },
      { id: "C", outputs: [1, 1, 1] },
    ],
  });
  const data = buildDistinguishData(problem);
  assert.deepEqual(data.equivalentPairs, [[0, 2]]);
  assert.equal(data.requiredPairs.length, 2);
  // Only sample index 1 separates A from B and C from B.
  assert.deepEqual(data.pairSampleMask, [1 << 1, 1 << 1]);
  assert.equal(data.sampleCover[0], 0n);
  assert.equal(data.sampleCover[1], 0b11n);
  assert.equal(data.sampleCover[2], 0n);
  assert.equal(minimumCoverSize(data), 1);
});

test("solver matches brute force on randomized problems", () => {
  const rng = mulberry32(20261005);
  for (let trial = 0; trial < 60; trial++) {
    const strategyCount = 2 + Math.floor(rng() * 8); // 2..9
    const sampleCount = 1 + Math.floor(rng() * 12); // 1..12
    const alphabet = 2 + Math.floor(rng() * 3); // 2..4 (small => collisions)
    const problem = parseProblem(randomProblemRaw(rng, strategyCount, sampleCount, alphabet));
    const data = buildDistinguishData(problem);
    const brute = bruteForceOptimum(problem);

    assert.equal(minimumCoverSize(data), brute.min, `size mismatch on trial ${trial}`);

    const order = Array.from({ length: sampleCount }, (_, i) => i).sort((a, b) =>
      problem.sampleIds[a]! < problem.sampleIds[b]! ? -1 : 1
    );
    const selected = firstFeasibleOfSize(data.sampleCover, data.fullCover, brute.min, order);
    assert.ok(selected !== null, `no feasible subset on trial ${trial}`);
    const selectedIds = selected!.map((i) => problem.sampleIds[i]!).sort();
    assert.deepEqual(selectedIds, brute.lexicographicFirst, `tie-break mismatch on trial ${trial}`);

    // Independent feasibility check of the returned subset.
    let covered = 0n;
    for (const index of selected!) covered |= data.sampleCover[index]!;
    assert.equal(covered, data.fullCover, `subset not feasible on trial ${trial}`);
  }
});

test("firstFeasibleOfSize returns null for infeasible sizes", () => {
  const problem = parseProblem({
    samples: ["s1", "s2"],
    strategies: [
      { id: "A", outputs: [1, 1] },
      { id: "B", outputs: [1, 2] },
      { id: "C", outputs: [2, 1] },
    ],
  });
  const data = buildDistinguishData(problem);
  assert.equal(minimumCoverSize(data), 2);
  assert.equal(firstFeasibleOfSize(data.sampleCover, data.fullCover, 0, [0, 1]), null);
  assert.equal(firstFeasibleOfSize(data.sampleCover, data.fullCover, 1, [0, 1]), null);
  assert.deepEqual(firstFeasibleOfSize(data.sampleCover, data.fullCover, 2, [0, 1]), [0, 1]);
});
