import test from "node:test";
import assert from "node:assert/strict";
import { ProblemInput, parseProblem } from "../src/model";
import { solve } from "../src/solve";
import { solveBruteForce } from "../src/brute";
import { buildCertificate, verifyCertificate } from "../src/certificate";

function solveBoth(input: ProblemInput) {
  const problem = parseProblem(input);
  return { problem, fast: solve(problem), brute: solveBruteForce(problem) };
}

test("picks the minimum-cost team", () => {
  const { problem, fast } = solveBoth({
    people: [
      { id: "a", skills: ["go", "ts"], cost: 9 },
      { id: "b", skills: ["go"], cost: 4 },
      { id: "c", skills: ["ts"], cost: 4 },
    ],
    required: { go: 1, ts: 1 },
  });
  assert.equal(fast.feasible, true);
  assert.equal(fast.cost, 8);
  assert.deepEqual(fast.team, ["b", "c"]);
  assert.ok(verifyCertificate(problem, buildCertificate(problem, fast.team)));
});

test("tie-breaks by smaller team size", () => {
  const { fast } = solveBoth({
    people: [
      { id: "solo", skills: ["x", "y"], cost: 2 },
      { id: "p1", skills: ["x"], cost: 1 },
      { id: "p2", skills: ["y"], cost: 1 },
    ],
    required: { x: 1, y: 1 },
  });
  // {solo} cost 2 size 1 vs {p1,p2} is cost 2 size 2 -> smaller size wins.
  assert.deepEqual(fast.team, ["solo"]);
});

test("tie-breaks by lexicographically smaller sorted id list", () => {
  const { fast } = solveBoth({
    people: [
      { id: "b", skills: ["x"], cost: 1 },
      { id: "c", skills: ["x"], cost: 1 },
      { id: "a", skills: ["x"], cost: 1 },
    ],
    required: { x: 2 },
  });
  // All size-2 teams cost 2; {a,b} is the lexicographically smallest id set.
  assert.deepEqual(fast.team, ["a", "b"]);
});

test("respects forbidden pairs", () => {
  const { problem, fast } = solveBoth({
    people: [
      { id: "cheap1", skills: ["x"], cost: 1 },
      { id: "cheap2", skills: ["x"], cost: 1 },
      { id: "backup", skills: ["x"], cost: 5 },
    ],
    forbiddenPairs: [["cheap1", "cheap2"]],
    required: { x: 2 },
  });
  assert.equal(fast.cost, 6);
  assert.deepEqual(fast.team, ["backup", "cheap1"]);
  const cert = buildCertificate(problem, fast.team);
  assert.equal(cert.verified, true);
  assert.deepEqual(cert.forbiddenPairChecks, [
    { pair: ["cheap1", "cheap2"], membersInTeam: ["cheap1"], ok: true },
  ]);
});

test("reports infeasible when a skill minimum is unreachable", () => {
  const { fast, brute } = solveBoth({
    people: [{ id: "a", skills: ["x"], cost: 1 }],
    required: { x: 1, y: 1 },
  });
  assert.equal(fast.feasible, false);
  assert.equal(brute.feasible, false);
});

test("reports infeasible when forbidden pairs block every team", () => {
  const { fast } = solveBoth({
    people: [
      { id: "a", skills: ["x"], cost: 1 },
      { id: "b", skills: ["x"], cost: 1 },
    ],
    forbiddenPairs: [["a", "b"]],
    required: { x: 2 },
  });
  assert.equal(fast.feasible, false);
});

test("empty problem with no requirements yields the empty team", () => {
  const { fast, brute } = solveBoth({ people: [] });
  assert.equal(fast.feasible, true);
  assert.equal(fast.cost, 0);
  assert.deepEqual(fast.team, []);
  assert.equal(brute.feasible, true);
});

test("rejects invalid input", () => {
  assert.throws(
    () => parseProblem({ people: Array.from({ length: 25 }, (_, i) => ({ id: `p${i}` })) }),
    /too many people/,
  );
  assert.throws(
    () =>
      parseProblem({
        people: [{ id: "a", skills: Array.from({ length: 13 }, (_, i) => `s${i}`) }],
      }),
    /too many skills/,
  );
  assert.throws(
    () => parseProblem({ people: [{ id: "a" }, { id: "a" }] }),
    /duplicate id/,
  );
  assert.throws(
    () => parseProblem({ people: [{ id: "a", cost: -1 }] }),
    /cost/,
  );
  assert.throws(
    () => parseProblem({ people: [{ id: "a" }], forbiddenPairs: [["a", "ghost"]] }),
    /unknown id "ghost"/,
  );
  assert.throws(
    () => parseProblem({ people: [{ id: "a" }], forbiddenPairs: [["a", "a"]] }),
    /cannot conflict with themselves/,
  );
  assert.throws(
    () => parseProblem({ people: [{ id: "a", skills: ["x"] }], required: { x: 1.5 } }),
    /integer/,
  );
});

test("certificate verification detects tampering", () => {
  const problem = parseProblem({
    people: [
      { id: "a", skills: ["x"], cost: 1 },
      { id: "b", skills: ["x"], cost: 2 },
    ],
    forbiddenPairs: [["a", "b"]],
    required: { x: 1 },
  });
  const cert = buildCertificate(problem, ["a"]);
  assert.ok(verifyCertificate(problem, cert));

  const tamperedCounts = { ...cert, skillCounts: { x: 5 } };
  assert.equal(verifyCertificate(problem, tamperedCounts), false);

  const tamperedCost = { ...cert, cost: 0 };
  assert.equal(verifyCertificate(problem, tamperedCost), false);

  // Team violating the forbidden pair: certificate builds but is not verified.
  const bad = buildCertificate(problem, ["a", "b"]);
  assert.equal(bad.verified, false);
  assert.equal(verifyCertificate(problem, bad), false);
});

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function randomInstance(rng: () => number): ProblemInput {
  const n = Math.floor(rng() * 13); // 0..12 people
  const s = 1 + Math.floor(rng() * 6); // 1..6 skills
  const skills = Array.from({ length: s }, (_, i) => `s${i}`);
  const people = Array.from({ length: n }, (_, i) => {
    const own = skills.filter(() => rng() < 0.4);
    return { id: `p${i}`, skills: own, cost: Math.floor(rng() * 10) };
  });
  const forbiddenPairs: Array<[string, string]> = [];
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      if (rng() < 0.15) forbiddenPairs.push([`p${i}`, `p${j}`]);
    }
  }
  const required: Record<string, number> = {};
  for (const skill of skills) {
    if (rng() < 0.8) required[skill] = Math.floor(rng() * 3); // 0..2
  }
  return { people, forbiddenPairs, required };
}

test("branch-and-bound matches exhaustive enumeration on random small instances", () => {
  const rng = mulberry32(20261005);
  for (let round = 0; round < 500; round++) {
    const input = randomInstance(rng);
    const problem = parseProblem(input);
    const fast = solve(problem);
    const brute = solveBruteForce(problem);
    assert.equal(fast.feasible, brute.feasible, `feasibility mismatch at round ${round}`);
    if (fast.feasible) {
      assert.equal(fast.cost, brute.cost, `cost mismatch at round ${round}`);
      assert.deepEqual(
        fast.team,
        brute.team,
        `team mismatch at round ${round}: ${JSON.stringify(input)}`,
      );
      const cert = buildCertificate(problem, fast.team);
      assert.equal(cert.verified, true, `certificate failed at round ${round}`);
      assert.ok(verifyCertificate(problem, cert));
    }
  }
});

test("solves a maximum-size instance (24 people, 12 skills)", () => {
  const rng = mulberry32(42);
  const skills = Array.from({ length: 12 }, (_, i) => `skill${i}`);
  const people = Array.from({ length: 24 }, (_, i) => ({
    id: `p${i}`,
    skills: skills.filter(() => rng() < 0.35),
    cost: 1 + Math.floor(rng() * 20),
  }));
  const forbiddenPairs: Array<[string, string]> = [];
  for (let i = 0; i < 24; i++) {
    for (let j = i + 1; j < 24; j++) {
      if (rng() < 0.05) forbiddenPairs.push([`p${i}`, `p${j}`]);
    }
  }
  const required: Record<string, number> = {};
  for (const skill of skills) required[skill] = 2;
  const problem = parseProblem({ people, forbiddenPairs, required });
  const result = solve(problem);
  assert.equal(result.feasible, true);
  const cert = buildCertificate(problem, result.team);
  assert.equal(cert.verified, true);
  assert.ok(verifyCertificate(problem, cert));
});

test("branch-and-bound matches enumeration at 20 people", () => {
  const rng = mulberry32(7);
  const skills = Array.from({ length: 8 }, (_, i) => `s${i}`);
  const people = Array.from({ length: 20 }, (_, i) => ({
    id: `p${i}`,
    skills: skills.filter(() => rng() < 0.4),
    cost: Math.floor(rng() * 10),
  }));
  const forbiddenPairs: Array<[string, string]> = [];
  for (let i = 0; i < 20; i++) {
    for (let j = i + 1; j < 20; j++) {
      if (rng() < 0.08) forbiddenPairs.push([`p${i}`, `p${j}`]);
    }
  }
  const required: Record<string, number> = {};
  for (const skill of skills) required[skill] = 2;
  const problem = parseProblem({ people, forbiddenPairs, required });
  const fast = solve(problem);
  const brute = solveBruteForce(problem);
  assert.equal(fast.feasible, brute.feasible);
  if (fast.feasible) {
    assert.equal(fast.cost, brute.cost);
    assert.deepEqual(fast.team, brute.team);
  }
});
