import test from "node:test";
import assert from "node:assert/strict";
import { solveBnB } from "../src/bnb.js";
import { solveBruteForce } from "../src/bruteForce.js";
import type { Problem } from "../src/model.js";

function idsOf(problem: Problem, indices: number[]): string[] {
  return indices.map((i) => problem.candidates[i]!.id).sort();
}

test("hand case: cheapest allow rule wins", () => {
  const p: Problem = {
    candidates: [
      { id: "cheap", cost: 1, effect: "allow", matches: ["s1"] },
      { id: "pricey", cost: 5, effect: "allow", matches: ["s1"] },
    ],
    samples: [{ id: "s1", expect: "allow" }],
  };
  for (const r of [solveBnB(p), solveBruteForce(p)]) {
    assert.equal(r.feasible, true);
    assert.equal(r.cost, 1);
    assert.deepEqual(idsOf(p, r.indices), ["cheap"]);
  }
});

test("hand case: deny priority forces an extra deny rule", () => {
  const p: Problem = {
    candidates: [
      { id: "r1", cost: 1, effect: "allow", matches: ["s1", "s2"] },
      { id: "r2", cost: 2, effect: "deny", matches: ["s1"] },
    ],
    samples: [
      { id: "s1", expect: "deny" },
      { id: "s2", expect: "allow" },
    ],
  };
  for (const r of [solveBnB(p), solveBruteForce(p)]) {
    assert.equal(r.feasible, true);
    assert.equal(r.cost, 3);
    assert.deepEqual(idsOf(p, r.indices), ["r1", "r2"]);
  }
});

test("hand case: default deny makes the empty subset optimal", () => {
  const p: Problem = {
    candidates: [{ id: "r1", cost: 1, effect: "allow", matches: ["s1"] }],
    samples: [
      { id: "s1", expect: "deny" },
      { id: "s2", expect: "deny" },
    ],
  };
  for (const r of [solveBnB(p), solveBruteForce(p)]) {
    assert.equal(r.feasible, true);
    assert.equal(r.cost, 0);
    assert.deepEqual(r.indices, []);
  }
});

test("infeasible: allow-expected sample with no allow rule", () => {
  const p: Problem = {
    candidates: [{ id: "r1", cost: 1, effect: "deny", matches: ["s1"] }],
    samples: [{ id: "s1", expect: "allow" }],
  };
  assert.equal(solveBnB(p).feasible, false);
  assert.equal(solveBruteForce(p).feasible, false);
});

test("infeasible: forced allow cannot be overridden for a deny sample", () => {
  const p: Problem = {
    candidates: [
      { id: "r1", cost: 1, effect: "allow", matches: ["s1", "s2"] },
      { id: "r2", cost: 1, effect: "deny", matches: ["s1"] },
    ],
    samples: [
      { id: "s1", expect: "allow" },
      { id: "s2", expect: "deny" },
    ],
  };
  const bnb = solveBnB(p);
  assert.equal(bnb.feasible, false);
  assert.equal(solveBruteForce(p).feasible, false);
  // r2 denies an allow-expected sample, so it can never be selected.
  assert.deepEqual(
    bnb.banned.map((i) => p.candidates[i]!.id),
    ["r2"],
  );
});

// Deterministic PRNG (mulberry32) for reproducible fuzzing.
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function randomProblem(rand: () => number, n: number, m: number): Problem {
  const samples = Array.from({ length: m }, (_, i) => ({
    id: `s${i}`,
    expect: rand() < 0.5 ? ("allow" as const) : ("deny" as const),
  }));
  const candidates = Array.from({ length: n }, (_, i) => ({
    id: `r${i}`,
    cost: Math.floor(rand() * 10),
    effect: rand() < 0.5 ? ("allow" as const) : ("deny" as const),
    matches: samples.filter(() => rand() < 0.35).map((s) => s.id),
  }));
  return { candidates, samples };
}

test("fuzz: branch-and-bound matches brute force on 400 random instances", () => {
  const rand = mulberry32(20261005);
  for (let iter = 0; iter < 400; iter++) {
    const n = Math.floor(rand() * 13); // 0..12 candidates
    const m = Math.floor(rand() * 7); // 0..6 samples
    const p = randomProblem(rand, n, m);
    const bnb = solveBnB(p);
    const brute = solveBruteForce(p);
    assert.equal(bnb.feasible, brute.feasible, `feasibility mismatch at iter ${iter}`);
    assert.equal(bnb.cost, brute.cost, `cost mismatch at iter ${iter}`);
    assert.deepEqual(idsOf(p, bnb.indices), idsOf(p, brute.indices), `subset mismatch at iter ${iter}`);
  }
});

test("stress: 18 candidates, brute force cross-check over all 262144 subsets", () => {
  const rand = mulberry32(18);
  const p = randomProblem(rand, 18, 6);
  const bnb = solveBnB(p);
  const brute = solveBruteForce(p);
  assert.equal(brute.subsetsEvaluated, 2 ** 18);
  assert.equal(bnb.feasible, brute.feasible);
  assert.equal(bnb.cost, brute.cost);
  assert.deepEqual(idsOf(p, bnb.indices), idsOf(p, brute.indices));
});
