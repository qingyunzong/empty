import { test } from "node:test";
import assert from "node:assert/strict";
import { parseInstance } from "../src/parse.js";
import { solve } from "../src/solve.js";
import { enumerateAll } from "../src/enumerate.js";
import { buildCertificate } from "../src/certificate.js";
import type { InstanceInput } from "../src/types.js";

function solveInput(input: InstanceInput) {
  return solve(parseInstance(input));
}

test("fixed example: cheapest feasible team wins", () => {
  const best = solveInput({
    people: [
      { id: "ana", skills: ["backend"], cost: 5 },
      { id: "bo", skills: ["backend", "devops"], cost: 9 },
      { id: "cy", skills: ["devops"], cost: 4 },
      { id: "di", skills: ["backend", "frontend"], cost: 7 },
      { id: "eli", skills: ["frontend"], cost: 3 },
    ],
    forbiddenPairs: [["ana", "bo"]],
    minSkills: { backend: 1, devops: 1, frontend: 1 },
  });
  assert.ok(best);
  assert.equal(best.cost, 11);
  assert.deepEqual(best.ids, ["cy", "di"]);
});

test("tie on cost: fewer members wins", () => {
  const best = solveInput({
    people: [
      { id: "p", skills: ["s1", "s2"], cost: 8 },
      { id: "q", skills: ["s1"], cost: 5 },
      { id: "r", skills: ["s2"], cost: 3 },
    ],
    minSkills: { s1: 1, s2: 1 },
  });
  assert.ok(best);
  assert.equal(best.cost, 8);
  assert.deepEqual(best.ids, ["p"]);
});

test("tie on cost and size: lexicographically smallest id set wins", () => {
  const best = solveInput({
    people: [
      { id: "y", skills: ["s1"], cost: 5 },
      { id: "x", skills: ["s1"], cost: 5 },
      { id: "z", skills: ["s1"], cost: 9 },
    ],
    minSkills: { s1: 1 },
  });
  assert.ok(best);
  assert.deepEqual(best.ids, ["x"]);
});

test("forbidden pair forces the more expensive cover", () => {
  const best = solveInput({
    people: [
      { id: "a", skills: ["s1"], cost: 1 },
      { id: "b", skills: ["s2"], cost: 1 },
      { id: "c", skills: ["s1", "s2"], cost: 5 },
    ],
    forbiddenPairs: [["a", "b"]],
    minSkills: { s1: 1, s2: 1 },
  });
  assert.ok(best);
  assert.equal(best.cost, 5);
  assert.deepEqual(best.ids, ["c"]);
});

test("infeasible when a required skill is missing entirely", () => {
  const best = solveInput({
    people: [{ id: "a", skills: ["s1"], cost: 1 }],
    minSkills: { s2: 1 },
  });
  assert.equal(best, null);
});

test("infeasible when forbidden pairs block the only suppliers", () => {
  const best = solveInput({
    people: [
      { id: "a", skills: ["s1"], cost: 1 },
      { id: "b", skills: ["s1"], cost: 1 },
    ],
    forbiddenPairs: [["a", "b"]],
    minSkills: { s1: 2 },
  });
  assert.equal(best, null);
});

test("no requirements: empty team is optimal", () => {
  const best = solveInput({
    people: [{ id: "a", skills: ["s1"], cost: 3 }],
  });
  assert.ok(best);
  assert.equal(best.cost, 0);
  assert.equal(best.size, 0);
  assert.deepEqual(best.ids, []);
});

test("numeric ids are normalized to strings", () => {
  const best = solveInput({
    people: [
      { id: 2, skills: ["s1"], cost: 4 },
      { id: 10, skills: ["s1"], cost: 4 },
    ],
    minSkills: { s1: 1 },
  });
  assert.ok(best);
  assert.deepEqual(best.ids, ["10"]);
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

function randomInstance(rand: () => number): InstanceInput {
  const peopleCount = 1 + Math.floor(rand() * 14);
  const skillCount = 1 + Math.floor(rand() * 6);
  const skillNames = Array.from({ length: skillCount }, (_, i) => `s${i}`);
  const people = Array.from({ length: peopleCount }, (_, i) => ({
    id: `p${i}`,
    skills: skillNames.filter(() => rand() < 0.35),
    cost: Math.floor(rand() * 21),
  }));
  const forbiddenPairs: Array<[string, string]> = [];
  for (let i = 0; i < peopleCount; i++) {
    for (let j = i + 1; j < peopleCount; j++) {
      if (rand() < 0.12) forbiddenPairs.push([`p${i}`, `p${j}`]);
    }
  }
  const minSkills: Record<string, number> = {};
  for (const name of skillNames) {
    const need = Math.floor(rand() * 3);
    if (need > 0) minSkills[name] = need;
  }
  return { people, forbiddenPairs, minSkills };
}

test("randomized cross-check: solver matches exhaustive enumeration", () => {
  for (let seed = 1; seed <= 300; seed++) {
    const instance = parseInstance(randomInstance(mulberry32(seed)));
    const fast = solve(instance);
    const brute = enumerateAll(instance);
    if (fast === null || brute.best === null) {
      assert.equal(fast, null, `seed ${seed}: solver found a team but enumeration did not`);
      assert.equal(brute.best, null, `seed ${seed}: enumeration found a team but solver did not`);
      continue;
    }
    assert.equal(fast.cost, brute.best.cost, `seed ${seed}: cost mismatch`);
    assert.equal(fast.size, brute.best.size, `seed ${seed}: size mismatch`);
    assert.deepEqual(fast.ids, brute.best.ids, `seed ${seed}: id set mismatch`);
    const certificate = buildCertificate(instance, fast.indices);
    assert.ok(certificate.ok, `seed ${seed}: certificate failed for solver output`);
  }
});

test("24 people with 12 skills solves quickly and certifies", () => {
  const rand = mulberry32(42);
  const skillNames = Array.from({ length: 12 }, (_, i) => `skill${i}`);
  const people = Array.from({ length: 24 }, (_, i) => ({
    id: `p${i}`,
    skills: skillNames.filter(() => rand() < 0.3),
    cost: Math.floor(rand() * 50),
  }));
  const forbiddenPairs: Array<[string, string]> = [];
  for (let i = 0; i < 24; i++) {
    for (let j = i + 1; j < 24; j++) {
      if (rand() < 0.08) forbiddenPairs.push([`p${i}`, `p${j}`]);
    }
  }
  const minSkills: Record<string, number> = {};
  for (const name of skillNames) minSkills[name] = 1;
  const instance = parseInstance({ people, forbiddenPairs, minSkills });
  const best = solve(instance);
  assert.ok(best);
  const certificate = buildCertificate(instance, best.indices);
  assert.ok(certificate.ok);
});
