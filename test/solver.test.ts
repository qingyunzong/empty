import { test } from "node:test";
import { deepStrictEqual, equal, ok, throws } from "node:assert/strict";
import { bruteForce } from "../src/brute.js";
import { runCli } from "../src/cli.js";
import { InfeasibleError, Problem, Solution, solve } from "../src/solver.js";

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

/** Independent feasibility + normalization check of a solver output. */
function assertValidSolution(problem: Problem, sol: Solution): void {
  const n = problem.items.length;
  const ids = problem.items.map((it) => it.id);
  equal(sol.bins.length, sol.binCount);
  equal(sol.loads.length, sol.binCount);
  equal(sol.bins.flat().length, n, "every item placed exactly once");
  deepStrictEqual([...sol.bins.flat()].sort((a, b) => a - b), [...ids].sort((a, b) => a - b));

  const binOf = new Map<number, number>();
  sol.bins.forEach((bin, b) => {
    for (const id of bin) binOf.set(id, b);
  });

  // Loads match sizes and respect capacity.
  sol.bins.forEach((bin, b) => {
    const load = bin.reduce((sum, id) => sum + problem.items.find((it) => it.id === id)!.size, 0);
    equal(load, sol.loads[b]);
    ok(load <= problem.capacity, `bin ${b + 1} within capacity`);
  });

  // Group constraint.
  const groupBin = new Map<string | number, number>();
  for (const item of problem.items) {
    if (item.group === undefined || item.group === null) continue;
    const b = binOf.get(item.id)!;
    const prev = groupBin.get(item.group);
    if (prev === undefined) groupBin.set(item.group, b);
    else equal(prev, b, `group ${String(item.group)} must share a bin`);
  }

  // Forbidden pairs.
  for (const [a, b] of problem.forbidden ?? []) {
    ok(binOf.get(a) !== binOf.get(b), `items ${a} and ${b} must be separated`);
  }

  // Assignment matches bins and is normalized by minimum item id.
  const binMins = sol.bins.map((bin) => Math.min(...bin));
  for (let b = 1; b < sol.binCount; b++) {
    ok(binMins[b - 1]! < binMins[b]!, "bins ordered by minimum item id");
  }
  for (const item of problem.items) {
    equal(sol.assignment[item.id], binOf.get(item.id)! + 1);
  }
  equal(sol.assignment[Math.min(...ids)], 1, "smallest item id is in bin 1");
}

test("handcrafted: groups merge, min bins wins", () => {
  const problem: Problem = {
    capacity: 10,
    items: [
      { id: 1, size: 4, group: "a" },
      { id: 2, size: 6 },
      { id: 3, size: 4, group: "a" },
      { id: 4, size: 5 },
    ],
  };
  const sol = solve(problem);
  equal(sol.binCount, 3);
  deepStrictEqual(sol.loads, [8, 6, 5]);
  deepStrictEqual(sol.bins, [[1, 3], [2], [4]]);
  assertValidSolution(problem, sol);
});

test("tie-break: lexicographically smallest canonical load sequence", () => {
  // Both [7,8,10] and [10,6,9] use 3 bins; lex-min picks [7,8,10].
  const problem: Problem = {
    capacity: 10,
    items: [
      { id: 1, size: 7 },
      { id: 2, size: 3 },
      { id: 3, size: 6 },
      { id: 4, size: 4 },
      { id: 5, size: 5 },
    ],
  };
  const sol = solve(problem);
  equal(sol.binCount, 3);
  deepStrictEqual(sol.loads, [7, 8, 10]);
  deepStrictEqual(sol.bins, [[1], [2, 5], [3, 4]]);
  assertValidSolution(problem, sol);
});

test("forbidden pair separated, lex-min keeps smallest id's bin lightest", () => {
  const problem: Problem = {
    capacity: 10,
    items: [
      { id: 1, size: 5 },
      { id: 2, size: 5 },
      { id: 3, size: 5 },
    ],
    forbidden: [[1, 2]],
  };
  const sol = solve(problem);
  equal(sol.binCount, 2);
  deepStrictEqual(sol.loads, [5, 10]);
  deepStrictEqual(sol.bins, [[1], [2, 3]]);
  assertValidSolution(problem, sol);
});

test("infeasible: forbidden pair inside one group", () => {
  const problem: Problem = {
    capacity: 10,
    items: [
      { id: 1, size: 3, group: "a" },
      { id: 2, size: 3, group: "a" },
    ],
    forbidden: [[1, 2]],
  };
  throws(() => solve(problem), InfeasibleError);
  throws(() => bruteForce(problem), InfeasibleError);
});

test("infeasible: group total size exceeds capacity", () => {
  const problem: Problem = {
    capacity: 10,
    items: [
      { id: 1, size: 6, group: "a" },
      { id: 2, size: 6, group: "a" },
    ],
  };
  throws(() => solve(problem), InfeasibleError);
  throws(() => bruteForce(problem), InfeasibleError);
});

test("validation: rejects bad input", () => {
  throws(() => solve({ capacity: 0, items: [{ id: 1, size: 1 }] }));
  throws(() => solve({ capacity: 5, items: [] }));
  throws(() => solve({ capacity: 5, items: [{ id: 1, size: 1 }, { id: 1, size: 1 }] }));
  throws(() => solve({ capacity: 5, items: [{ id: 1, size: 6 }] }), InfeasibleError);
  throws(() => solve({ capacity: 5, items: [{ id: 1, size: 1 }], forbidden: [[1, 9]] }));
  throws(() =>
    solve({
      capacity: 5,
      items: Array.from({ length: 21 }, (_, i) => ({ id: i + 1, size: 1 })),
    }),
  );
});

function randomProblem(rand: () => number, n: number): Problem {
  const capacity = 5 + Math.floor(rand() * 8); // 5..12
  const items = Array.from({ length: n }, (_, i) => {
    const size = 1 + Math.floor(rand() * capacity);
    const withGroup = rand() < 0.35;
    const group = withGroup ? `g${Math.floor(rand() * 3)}` : undefined;
    return group === undefined ? { id: i + 1, size } : { id: i + 1, size, group };
  });
  const forbidden: [number, number][] = [];
  for (let a = 1; a <= n; a++) {
    for (let b = a + 1; b <= n; b++) {
      if (rand() < 0.12) forbidden.push([a, b]);
    }
  }
  return { capacity, items, forbidden };
}

test("cross-check against partition enumeration on random small instances", () => {
  const rand = mulberry32(20261005);
  let feasibleCount = 0;
  let infeasibleCount = 0;
  for (let trial = 0; trial < 400; trial++) {
    const n = 1 + Math.floor(rand() * 8); // 1..8 items
    const problem = randomProblem(rand, n);
    let sol: Solution | null = null;
    let expected: Solution | null = null;
    try {
      sol = solve(problem);
    } catch (err) {
      ok(err instanceof InfeasibleError, `unexpected solver error: ${(err as Error).message}`);
    }
    try {
      expected = bruteForce(problem);
    } catch (err) {
      ok(err instanceof InfeasibleError, `unexpected brute force error: ${(err as Error).message}`);
    }
    equal(sol === null, expected === null, `feasibility mismatch on ${JSON.stringify(problem)}`);
    if (sol === null || expected === null) {
      infeasibleCount++;
      continue;
    }
    feasibleCount++;
    assertValidSolution(problem, sol);
    equal(sol.binCount, expected.binCount, `bin count mismatch on ${JSON.stringify(problem)}`);
    deepStrictEqual(sol.loads, expected.loads, `canonical loads mismatch on ${JSON.stringify(problem)}`);
  }
  ok(feasibleCount > 300, `expected mostly feasible instances, got ${feasibleCount}`);
  ok(infeasibleCount > 0, "expected some infeasible instances in the mix");
});

test("20-item instances solve quickly and stay feasible", () => {
  const configs: [number, number, number, number, number][] = [
    // [capacity, minSize, maxSize, forbiddenProb, groupProb]
    [20, 4, 10, 0.1, 0],
    [20, 4, 10, 0.2, 0.2],
    [15, 3, 8, 0.1, 0.3],
    [10, 1, 10, 0, 0],
    [10, 1, 5, 0, 0],
    [30, 5, 15, 0.15, 0.15],
  ];
  const rand = mulberry32(1337);
  let solved = 0;
  for (const [capacity, lo, hi, fprob, gprob] of configs) {
    for (let trial = 0; trial < 10; trial++) {
      const items = Array.from({ length: 20 }, (_, i) => {
        const size = lo + Math.floor(rand() * (hi - lo + 1));
        const group = rand() < gprob ? `g${Math.floor(rand() * 4)}` : undefined;
        return group === undefined ? { id: i + 1, size } : { id: i + 1, size, group };
      });
      const forbidden: [number, number][] = [];
      for (let a = 1; a <= 20; a++) {
        for (let b = a + 1; b <= 20; b++) {
          if (rand() < fprob) forbidden.push([a, b]);
        }
      }
      const problem: Problem = { capacity, items, forbidden };
      const start = Date.now();
      try {
        const sol = solve(problem);
        solved++;
        assertValidSolution(problem, sol);
        ok(Date.now() - start < 5000, `solve took ${Date.now() - start}ms`);
      } catch (err) {
        ok(err instanceof InfeasibleError, `unexpected error: ${(err as Error).message}`);
      }
    }
  }
  ok(solved > 30, `expected mostly feasible instances, got ${solved}`);
});

test("CLI end-to-end with --verify", () => {
  const input = JSON.stringify({
    capacity: 10,
    items: [
      { id: 1, size: 4, group: "a" },
      { id: 2, size: 6 },
      { id: 3, size: 4, group: "a" },
      { id: 4, size: 5 },
    ],
    forbidden: [[2, 4]],
  });
  const result = runCli(["--verify"], () => input);
  equal(result.code, 0, result.stderr);
  ok(result.stderr.includes("verify: ok"));
  const sol = JSON.parse(result.stdout) as Solution;
  equal(sol.binCount, 3);
  deepStrictEqual(sol.loads, [8, 6, 5]);
  deepStrictEqual(sol.bins, [[1, 3], [2], [4]]);
});
