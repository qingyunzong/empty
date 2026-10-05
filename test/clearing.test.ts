import test from "node:test";
import { deepEqual, equal, ok, throws } from "node:assert/strict";
import {
  normalizeProblem,
  solve,
  verifyCertificate,
  type ClearingProblem,
  type ClearingSolution,
  type RawProblem,
} from "../src/clearing.js";
import { bruteForce, forwardDpMinPenalty } from "../src/verify.js";

const SAMPLE: RawProblem = {
  initialBalances: { A: "0", B: "100", C: "10" },
  bills: [
    { id: "b1", payer: "B", payee: "A", amount: "60", penalty: "3" },
    { id: "b2", payer: "A", payee: "C", amount: "50", penalty: "10" },
    { id: "b3", payer: "C", payee: "B", amount: "40", penalty: "1" },
    { id: "b4", payer: "B", payee: "C", amount: "90", penalty: "8" },
  ],
};

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

function randomProblem(rng: () => number, n: number): RawProblem {
  const accountCount = 2 + Math.floor(rng() * 3);
  const accounts = Array.from({ length: accountCount }, (_, i) => `acc${i}`);
  const initialBalances: Record<string, number> = {};
  for (const account of accounts) {
    initialBalances[account] = Math.floor(rng() * 51);
  }
  const bills = Array.from({ length: n }, (_, i) => ({
    id: `b${i}`,
    payer: accounts[Math.floor(rng() * accountCount)],
    payee: accounts[Math.floor(rng() * accountCount)],
    amount: Math.floor(rng() * 60),
    penalty: Math.floor(rng() * 21),
  }));
  return { initialBalances, bills };
}

function chainProblem(n: number): RawProblem {
  const initialBalances: Record<string, number> = { a0: 100 };
  for (let i = 1; i <= n; i++) initialBalances[`a${i}`] = 0;
  const bills = Array.from({ length: n }, (_, i) => ({
    id: `c${i}`,
    payer: `a${i}`,
    payee: `a${i + 1}`,
    amount: 100,
    penalty: i + 1,
  }));
  return { initialBalances, bills };
}

test("sample: order-dependent chain with one strategic rejection", () => {
  const problem = normalizeProblem(SAMPLE);
  const solution = solve(problem);
  equal(solution.minPenalty, 8n);
  deepEqual(solution.executed.map((b) => b.id), ["b1", "b2", "b3"]);
  deepEqual(solution.rejected.map((b) => b.id), ["b4"]);
  equal(solution.certificate.length, 3);
  equal(solution.finalBalances.get("A"), 10n);
  equal(solution.finalBalances.get("B"), 80n);
  equal(solution.finalBalances.get("C"), 20n);
  ok(verifyCertificate(problem, solution).ok);
  equal(forwardDpMinPenalty(problem), 8n);
  equal(bruteForce(problem).minPenalty, 8n);
});

test("all bills payable: nothing rejected", () => {
  const problem = normalizeProblem({
    initialBalances: { A: 100, B: 50 },
    bills: [
      { id: "x", payer: "A", payee: "B", amount: 30, penalty: 5 },
      { id: "y", payer: "B", payee: "A", amount: 60, penalty: 7 },
    ],
  });
  const solution = solve(problem);
  equal(solution.minPenalty, 0n);
  equal(solution.executed.length, 2);
  equal(solution.rejected.length, 0);
  ok(verifyCertificate(problem, solution).ok);
});

test("nothing payable: everything rejected, penalties summed", () => {
  const problem = normalizeProblem({
    initialBalances: { A: 0, B: 0 },
    bills: [
      { id: "x", payer: "A", payee: "B", amount: 10, penalty: 5 },
      { id: "y", payer: "B", payee: "A", amount: 20, penalty: 7 },
    ],
  });
  const solution = solve(problem);
  equal(solution.minPenalty, 12n);
  equal(solution.executed.length, 0);
  equal(solution.rejected.length, 2);
  ok(verifyCertificate(problem, solution).ok);
});

test("empty input: zero penalty, empty certificate", () => {
  const problem = normalizeProblem({ initialBalances: { A: 5 }, bills: [] });
  const solution = solve(problem);
  equal(solution.minPenalty, 0n);
  equal(solution.executed.length, 0);
  equal(solution.certificate.length, 0);
  ok(verifyCertificate(problem, solution).ok);
});

test("execution order matters: payer must be funded first", () => {
  const problem = normalizeProblem(chainProblem(5));
  const solution = solve(problem);
  equal(solution.minPenalty, 0n);
  deepEqual(solution.executed.map((b) => b.id), ["c0", "c1", "c2", "c3", "c4"]);
  ok(verifyCertificate(problem, solution).ok);
});

test("accepting a cheap bill can be worse than rejecting it", () => {
  const problem = normalizeProblem({
    initialBalances: { A: 100 },
    bills: [
      { id: "cheap", payer: "A", payee: "B", amount: 60, penalty: 1 },
      { id: "vital", payer: "A", payee: "C", amount: 50, penalty: 100 },
    ],
  });
  const solution = solve(problem);
  equal(solution.minPenalty, 1n);
  deepEqual(solution.executed.map((b) => b.id), ["vital"]);
  deepEqual(solution.rejected.map((b) => b.id), ["cheap"]);
  ok(verifyCertificate(problem, solution).ok);
});

test("self-transfer requires sufficient balance but changes nothing", () => {
  const problem = normalizeProblem({
    initialBalances: { A: 10 },
    bills: [{ id: "loop", payer: "A", payee: "A", amount: 10, penalty: 4 }],
  });
  const solution = solve(problem);
  equal(solution.minPenalty, 0n);
  equal(solution.finalBalances.get("A"), 10n);
  ok(verifyCertificate(problem, solution).ok);
});

test("16-bill chain: full execution, zero penalty", () => {
  const problem = normalizeProblem(chainProblem(16));
  const solution = solve(problem);
  equal(solution.minPenalty, 0n);
  equal(solution.executed.length, 16);
  equal(solution.certificate.length, 16);
  equal(solution.finalBalances.get("a16"), 100n);
  ok(verifyCertificate(problem, solution).ok);
  equal(forwardDpMinPenalty(problem), 0n);
});

test("certificate detects tampered balances", () => {
  const problem = normalizeProblem(SAMPLE);
  const solution = solve(problem);
  const first = solution.certificate[0];
  const wrongBalances = new Map(first.balancesAfter);
  wrongBalances.set("A", (wrongBalances.get("A") ?? 0n) + 1n);
  const tampered: ClearingSolution = {
    ...solution,
    certificate: solution.certificate.map((step, i) =>
      i === 0 ? { ...step, balancesAfter: wrongBalances } : step,
    ),
  };
  equal(verifyCertificate(problem, tampered).ok, false);
});

test("certificate detects illegal execution order", () => {
  const problem = normalizeProblem(SAMPLE);
  const solution = solve(problem);
  const executed = [...solution.executed];
  const certificate = [...solution.certificate];
  [executed[0], executed[1]] = [executed[1], executed[0]];
  [certificate[0], certificate[1]] = [certificate[1], certificate[0]];
  const reordered: ClearingSolution = { ...solution, executed, certificate };
  equal(verifyCertificate(problem, reordered).ok, false);
});

test("certificate detects understated penalty", () => {
  const problem = normalizeProblem(SAMPLE);
  const solution = solve(problem);
  const understated: ClearingSolution = {
    ...solution,
    minPenalty: solution.minPenalty - 1n,
  };
  equal(verifyCertificate(problem, understated).ok, false);
});

test("input validation rejects malformed problems", () => {
  throws(() =>
    normalizeProblem({
      initialBalances: {},
      bills: Array.from({ length: 17 }, (_, i) => ({
        id: `b${i}`,
        payer: "A",
        payee: "B",
        amount: 1,
        penalty: 1,
      })),
    }),
  );
  throws(() =>
    normalizeProblem({
      initialBalances: {},
      bills: [{ id: "b", payer: "A", payee: "B", amount: 1.5, penalty: 1 }],
    }),
  );
  throws(() =>
    normalizeProblem({
      initialBalances: {},
      bills: [{ id: "b", payer: "A", payee: "B", amount: "1.5", penalty: 1 }],
    }),
  );
  throws(() =>
    normalizeProblem({
      initialBalances: {},
      bills: [{ id: "b", payer: "A", payee: "B", amount: 1, penalty: -1 }],
    }),
  );
  throws(() =>
    normalizeProblem({
      initialBalances: {},
      bills: [
        { id: "b", payer: "A", payee: "B", amount: 1, penalty: 1 },
        { id: "b", payer: "A", payee: "B", amount: 2, penalty: 2 },
      ],
    }),
  );
});

test("randomized n<=8: DP equals exhaustive subset x permutation search", () => {
  const rng = mulberry32(20261005);
  for (let iteration = 0; iteration < 150; iteration++) {
    const n = 1 + Math.floor(rng() * 8);
    const problem = normalizeProblem(randomProblem(rng, n));
    const solution = solve(problem);
    const brute = bruteForce(problem);
    const forward = forwardDpMinPenalty(problem);
    equal(
      solution.minPenalty,
      brute.minPenalty,
      `iteration ${iteration}: DP ${solution.minPenalty} != brute ${brute.minPenalty}`,
    );
    equal(
      solution.minPenalty,
      forward,
      `iteration ${iteration}: DP ${solution.minPenalty} != forward ${forward}`,
    );
    const check = verifyCertificate(problem, solution);
    ok(check.ok, `iteration ${iteration}: certificate invalid: ${check.reason}`);
  }
});

test("randomized n=16: DP equals forward DP, certificate replays", () => {
  const rng = mulberry32(12648430);
  for (let iteration = 0; iteration < 30; iteration++) {
    const problem = normalizeProblem(randomProblem(rng, 16));
    const solution = solve(problem);
    const forward = forwardDpMinPenalty(problem);
    equal(
      solution.minPenalty,
      forward,
      `iteration ${iteration}: DP ${solution.minPenalty} != forward ${forward}`,
    );
    const check = verifyCertificate(problem, solution);
    ok(check.ok, `iteration ${iteration}: certificate invalid: ${check.reason}`);
  }
});
