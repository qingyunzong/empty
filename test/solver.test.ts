import { test } from "node:test";
import { deepEqual, equal, ok } from "node:assert/strict";
import { decide, matchGlob, parseProblem, Problem, Rule } from "../src/model.js";
import {
  buildEvidence,
  solveBranchAndBound,
  solveBruteForce,
} from "../src/solver.js";

function rule(
  id: string,
  action: "allow" | "deny",
  cost: number,
  subject = "*",
  op = "*",
  resource = "*",
): Rule {
  return { id, action, cost, match: { subject, op, resource } };
}

test("matchGlob supports exact, wildcard and prefix glob", () => {
  ok(matchGlob("*", "anything"));
  ok(matchGlob("alice", "alice"));
  ok(!matchGlob("alice", "bob"));
  ok(matchGlob("secret/*", "secret/x"));
  ok(!matchGlob("secret/*", "doc/x"));
  ok(matchGlob("doc-*", "doc-1"));
  ok(!matchGlob("doc-*", "dox-1"));
});

test("decide: deny wins over allow on conflict", () => {
  const rules = [
    rule("a1", "allow", 1),
    rule("d1", "deny", 1),
  ];
  const result = decide(rules, { subject: "x", op: "y", resource: "z" });
  equal(result.decision, "deny");
  equal(result.matched.length, 2);
});

test("decide: default is deny when nothing matches", () => {
  const rules = [rule("a1", "allow", 1, "alice")];
  const result = decide(rules, { subject: "bob", op: "read", resource: "doc" });
  equal(result.decision, "deny");
  equal(result.matched.length, 0);
});

test("decide: allow when only allow rules match", () => {
  const rules = [rule("a1", "allow", 1), rule("d1", "deny", 1, "carol")];
  const result = decide(rules, { subject: "alice", op: "read", resource: "doc" });
  equal(result.decision, "allow");
});

const feasibleProblem: Problem = parseProblem({
  candidates: [
    { id: "allow-alice-read", action: "allow", cost: 2,
      match: { subject: "alice", op: "read", resource: "*" } },
    { id: "allow-all-read", action: "allow", cost: 1,
      match: { subject: "*", op: "read", resource: "*" } },
    { id: "deny-secret", action: "deny", cost: 1,
      match: { subject: "*", op: "*", resource: "secret/*" } },
    { id: "allow-bob-secret", action: "allow", cost: 5,
      match: { subject: "bob", op: "read", resource: "secret/*" } },
    { id: "allow-alice-write", action: "allow", cost: 4,
      match: { subject: "alice", op: "write", resource: "*" } },
  ],
  samples: [
    { id: "s1", expect: "allow",
      request: { subject: "alice", op: "read", resource: "doc/a" } },
    { id: "s2", expect: "deny",
      request: { subject: "alice", op: "read", resource: "secret/x" } },
    { id: "s3", expect: "allow",
      request: { subject: "bob", op: "read", resource: "doc/b" } },
    { id: "s4", expect: "deny",
      request: { subject: "carol", op: "write", resource: "doc/c" } },
    { id: "s5", expect: "allow",
      request: { subject: "alice", op: "write", resource: "doc/d" } },
  ],
});

test("solver finds known minimum-cost subset", () => {
  const result = solveBranchAndBound(feasibleProblem);
  ok(result.feasible);
  equal(result.cost, 6);
  deepEqual(
    result.selected.map((r) => r.id).sort(),
    ["allow-alice-write", "allow-all-read", "deny-secret"],
  );
});

test("branch-and-bound agrees with brute force on the example", () => {
  const bnb = solveBranchAndBound(feasibleProblem);
  const brute = solveBruteForce(feasibleProblem);
  equal(brute.explored, 1 << feasibleProblem.candidates.length);
  equal(bnb.feasible, brute.feasible);
  equal(bnb.cost, brute.cost);
  equal(bnb.mask, brute.mask);
});

test("evidence explains every sample and all pass", () => {
  const bnb = solveBranchAndBound(feasibleProblem);
  const evidence = buildEvidence(feasibleProblem, bnb.selected);
  equal(evidence.length, feasibleProblem.samples.length);
  for (const ev of evidence) {
    ok(ev.ok, `sample ${ev.sampleId} should pass`);
    equal(ev.decision, ev.expected);
  }
  const s2 = evidence.find((e) => e.sampleId === "s2");
  ok(s2);
  equal(s2.decision, "deny");
  ok(s2.matched.some((m) => m.id === "deny-secret" && m.action === "deny"));
  ok(s2.matched.some((m) => m.id === "allow-all-read" && m.action === "allow"));
  const s4 = evidence.find((e) => e.sampleId === "s4");
  ok(s4);
  equal(s4.matched.length, 0);
});

test("infeasible problem is reported by both solvers", () => {
  const problem = parseProblem({
    candidates: [
      { id: "allow-doc", action: "allow", cost: 1, match: { resource: "doc" } },
      { id: "deny-doc", action: "deny", cost: 1, match: { resource: "doc" } },
    ],
    samples: [
      { id: "want-allow", expect: "allow",
        request: { subject: "a", op: "read", resource: "doc" } },
      { id: "want-deny", expect: "deny",
        request: { subject: "a", op: "read", resource: "doc" } },
    ],
  });
  const bnb = solveBranchAndBound(problem);
  const brute = solveBruteForce(problem);
  ok(!bnb.feasible);
  ok(!brute.feasible);
});

test("tie-break prefers fewer rules then lower mask", () => {
  const problem = parseProblem({
    candidates: [
      { id: "r0", action: "allow", cost: 1 },
      { id: "r1", action: "allow", cost: 1 },
    ],
    samples: [
      { id: "s", expect: "allow",
        request: { subject: "a", op: "b", resource: "c" } },
    ],
  });
  const bnb = solveBranchAndBound(problem);
  const brute = solveBruteForce(problem);
  equal(bnb.cost, 1);
  deepEqual(bnb.selected.map((r) => r.id), ["r0"]);
  equal(bnb.mask, brute.mask);
});

test("empty candidate set: feasible only if all samples expect deny", () => {
  const denyOnly = parseProblem({
    candidates: [],
    samples: [
      { id: "s", expect: "deny",
        request: { subject: "a", op: "b", resource: "c" } },
    ],
  });
  const result = solveBranchAndBound(denyOnly);
  ok(result.feasible);
  equal(result.cost, 0);
  const allowWanted = parseProblem({
    candidates: [],
    samples: [
      { id: "s", expect: "allow",
        request: { subject: "a", op: "b", resource: "c" } },
    ],
  });
  ok(!solveBranchAndBound(allowWanted).feasible);
  ok(!solveBruteForce(allowWanted).feasible);
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

function randomProblem(rand: () => number, n: number, m: number): Problem {
  const subjects = ["alice", "bob", "carol"];
  const ops = ["read", "write"];
  const resources = ["doc/a", "doc/b", "secret/x"];
  const pick = <T>(arr: T[]): T => arr[Math.floor(rand() * arr.length)] as T;
  const maybeGlob = (value: string): string => {
    const roll = rand();
    if (roll < 0.4) return "*";
    if (roll < 0.6) return value;
    return pick([value, "*", value.split("/")[0] + "/*"]);
  };
  const candidates = Array.from({ length: n }, (_, i) => ({
    id: `r${i}`,
    action: rand() < 0.5 ? "allow" : "deny",
    cost: Math.floor(rand() * 5),
    match: {
      subject: maybeGlob(pick(subjects)),
      op: maybeGlob(pick(ops)),
      resource: maybeGlob(pick(resources)),
    },
  }));
  const samples = Array.from({ length: m }, (_, i) => ({
    id: `s${i}`,
    expect: rand() < 0.5 ? "allow" : "deny",
    request: {
      subject: pick(subjects),
      op: pick(ops),
      resource: pick(resources),
    },
  }));
  return parseProblem({ candidates, samples });
}

test("randomized cross-check: branch-and-bound equals brute force", () => {
  const rand = mulberry32(20261007);
  for (let iter = 0; iter < 400; iter++) {
    const n = Math.floor(rand() * 13);
    const m = 1 + Math.floor(rand() * 6);
    const problem = randomProblem(rand, n, m);
    const bnb = solveBranchAndBound(problem);
    const brute = solveBruteForce(problem);
    equal(
      bnb.feasible,
      brute.feasible,
      `iter ${iter}: feasibility mismatch (n=${n}, m=${m})`,
    );
    if (bnb.feasible) {
      equal(bnb.cost, brute.cost, `iter ${iter}: cost mismatch`);
      equal(bnb.mask, brute.mask, `iter ${iter}: mask mismatch`);
      const evidence = buildEvidence(problem, bnb.selected);
      for (const ev of evidence) {
        ok(ev.ok, `iter ${iter}: sample ${ev.sampleId} fails under chosen subset`);
      }
    }
  }
});

test("18 candidates: full enumeration of 262144 subsets agrees with solver", () => {
  const rand = mulberry32(18);
  const problem = randomProblem(rand, 18, 6);
  const bnb = solveBranchAndBound(problem);
  const brute = solveBruteForce(problem);
  equal(brute.explored, 1 << 18);
  equal(bnb.feasible, brute.feasible);
  if (bnb.feasible) {
    equal(bnb.cost, brute.cost);
    equal(bnb.mask, brute.mask);
  }
});

test("parseProblem rejects more than 18 candidates", () => {
  const raw = {
    candidates: Array.from({ length: 19 }, (_, i) => ({
      id: `r${i}`,
      action: "allow",
      cost: 1,
    })),
    samples: [],
  };
  let threw = false;
  try {
    parseProblem(raw);
  } catch (err) {
    threw = true;
    ok((err as Error).message.includes("at most 18"));
  }
  ok(threw);
});

test("parseProblem rejects invalid input shapes", () => {
  const bad = [
    null,
    {},
    { candidates: [{ id: "x", action: "maybe", cost: 1 }], samples: [] },
    { candidates: [{ id: "x", action: "allow", cost: -1 }], samples: [] },
    { candidates: [{ id: "x", action: "allow", cost: 1.5 }], samples: [] },
    { candidates: [{ id: "x", action: "allow", cost: 1 }],
      samples: [{ id: "s", expect: "allow" }] },
    { candidates: [{ id: "x", action: "allow", cost: 1 },
                   { id: "x", action: "deny", cost: 1 }], samples: [] },
  ];
  for (const raw of bad) {
    let threw = false;
    try {
      parseProblem(raw);
    } catch {
      threw = true;
    }
    ok(threw, `should reject: ${JSON.stringify(raw)}`);
  }
});
