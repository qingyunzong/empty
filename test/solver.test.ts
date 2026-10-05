import { test, describe } from "node:test";
import * as assert from "node:assert/strict";
import { parseProblem, Problem } from "../src/model";
import { solve, NegativeCycleError } from "../src/solver";
import { bruteForce } from "../src/brute";

function problem(raw: unknown): Problem {
  return parseProblem(raw);
}

describe("fixed cases", () => {
  test("classic network, amount 2 -> cost 8", () => {
    const p = problem({
      source: "A",
      sink: "D",
      amount: 2,
      edges: [
        { from: "A", to: "B", segments: [{ capacity: 2, cost: 1 }] },
        { from: "A", to: "C", segments: [{ capacity: 2, cost: 4 }] },
        { from: "B", to: "C", segments: [{ capacity: 1, cost: 2 }] },
        { from: "B", to: "D", segments: [{ capacity: 1, cost: 3 }] },
        { from: "C", to: "D", segments: [{ capacity: 2, cost: 1 }] },
      ],
    });
    const r = solve(p);
    assert.equal(r.status, "ok");
    assert.equal(r.minCost, 8);
    assert.equal(r.certificate!.valid, true);
  });

  test("piecewise fees: convex segments are priced per segment", () => {
    const p = problem({
      source: "A",
      sink: "D",
      amount: 3,
      edges: [
        { from: "A", to: "B", segments: [{ capacity: 1, cost: 0 }, { capacity: 2, cost: 10 }] },
        { from: "B", to: "D", segments: [{ capacity: 3, cost: 1 }] },
        { from: "A", to: "D", segments: [{ capacity: 1, cost: 20 }] },
      ],
    });
    const r = solve(p);
    assert.equal(r.status, "ok");
    // 3 units via B: (1*0 + 2*10) + 3*1 = 23, cheaper than detouring the
    // expensive direct edge.
    assert.equal(r.minCost, 23);
  });

  test("negative fees without negative cycles", () => {
    const p = problem({
      source: "A",
      sink: "D",
      amount: 2,
      edges: [
        { from: "A", to: "B", segments: [{ capacity: 2, cost: -3 }] },
        { from: "B", to: "D", segments: [{ capacity: 2, cost: 1 }] },
        { from: "A", to: "D", segments: [{ capacity: 1, cost: 5 }] },
      ],
    });
    const r = solve(p);
    assert.equal(r.status, "ok");
    assert.equal(r.minCost, -4); // 2 * (-3 + 1)
    assert.equal(r.certificate!.valid, true);
  });

  test("amount 0 is trivially optimal", () => {
    const p = problem({
      source: "A",
      sink: "D",
      amount: 0,
      edges: [{ from: "A", to: "D", segments: [{ capacity: 1, cost: 7 }] }],
    });
    const r = solve(p);
    assert.equal(r.status, "ok");
    assert.equal(r.minCost, 0);
    assert.deepEqual(r.flows, []);
    assert.equal(r.certificate!.valid, true);
  });

  test("infeasible amount reported", () => {
    const p = problem({
      source: "A",
      sink: "D",
      amount: 2,
      edges: [
        { from: "A", to: "B", segments: [{ capacity: 1, cost: 1 }] },
        { from: "B", to: "D", segments: [{ capacity: 1, cost: 1 }] },
      ],
    });
    const r = solve(p);
    assert.equal(r.status, "infeasible");
  });

  test("negative-cost cycle in input is rejected", () => {
    const p = problem({
      source: "A",
      sink: "C",
      amount: 1,
      edges: [
        { from: "A", to: "B", segments: [{ capacity: 1, cost: -2 }] },
        { from: "B", to: "A", segments: [{ capacity: 1, cost: -2 }] },
        { from: "A", to: "C", segments: [{ capacity: 1, cost: 1 }] },
      ],
    });
    assert.throws(() => solve(p), NegativeCycleError);
  });

  test("non-convex segments rejected at parse time", () => {
    assert.throws(
      () =>
        problem({
          source: "A",
          sink: "B",
          amount: 1,
          edges: [
            { from: "A", to: "B", segments: [{ capacity: 1, cost: 5 }, { capacity: 1, cost: 2 }] },
          ],
        }),
      /non-decreasing/
    );
  });
});

describe("randomized cross-check vs brute force", () => {
  // Deterministic PRNG (mulberry32) for reproducible runs.
  function rng(seed: number): () => number {
    let a = seed >>> 0;
    return () => {
      a |= 0;
      a = (a + 0x6d2b79f5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  function randomProblem(rand: () => number, i: number): Problem {
    const n = 4 + Math.floor(rand() * 2); // 4-5 nodes
    const names = Array.from({ length: n }, (_, k) => "N" + k);
    const edges = [];
    // Guarantee a source->sink path so most cases are feasible.
    for (let k = 0; k + 1 < n; k++) {
      edges.push({
        from: names[k]!,
        to: names[k + 1]!,
        segments: [{ capacity: 2 + Math.floor(rand() * 3), cost: -2 + Math.floor(rand() * 9) }],
      });
    }
    const m = 4 + Math.floor(rand() * 3); // 4-6 extra edges
    for (let e = 0; e < m; e++) {
      const u = Math.floor(rand() * n);
      let v = Math.floor(rand() * n);
      if (v === u) v = (v + 1) % n;
      const segCount = 1 + Math.floor(rand() * 2);
      const segments = [];
      let rate = -4 + Math.floor(rand() * 13); // costs in [-4, 8]
      for (let s = 0; s < segCount; s++) {
        segments.push({ capacity: 1 + Math.floor(rand() * 3), cost: rate });
        rate += Math.floor(rand() * 4); // keep convex
      }
      edges.push({ from: names[u]!, to: names[v]!, segments });
    }
    return problem({
      source: names[0],
      sink: names[n - 1],
      amount: 1 + Math.floor(rand() * 4), // 1..4
      edges,
      // tag for error messages
      _case: i,
    } as unknown as Problem);
  }

  const CASES = 400;
  test(`${CASES} random small networks agree with enumeration`, () => {
    const rand = rng(20261005);
    let solved = 0;
    let infeasible = 0;
    let skippedNegativeCycle = 0;
    for (let i = 0; i < CASES; i++) {
      const p = randomProblem(rand, i);
      let r;
      try {
        r = solve(p);
      } catch (e) {
        if (e instanceof NegativeCycleError) {
          skippedNegativeCycle++;
          continue;
        }
        throw e;
      }
      const b = bruteForce(p);
      assert.equal(r.status, b.status, `case ${i}: status mismatch`);
      if (r.status === "ok") {
        assert.equal(r.minCost, b.minCost, `case ${i}: cost mismatch`);
        assert.equal(r.certificate!.valid, true, `case ${i}: invalid certificate`);
        solved++;
      } else {
        infeasible++;
      }
    }
    process.stdout.write(
      `  [random] solved=${solved} infeasible=${infeasible} skippedNegativeCycle=${skippedNegativeCycle}\n`
    );
    assert.ok(solved > 0, "expected at least some solvable cases");
  });
});
