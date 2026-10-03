import test from "node:test";
import assert from "node:assert/strict";
import { solve } from "../src/solver.js";
import { bruteForce } from "../src/brute.js";
import { randomSpec } from "./helpers.js";

test("solver matches brute-force topological enumeration for n <= 8", () => {
  const sizes = [2, 3, 4, 5, 6, 7, 8];
  for (const n of sizes) {
    for (let seed = 1; seed <= 8; seed++) {
      const spec = randomSpec(seed * 100 + n, n);
      const expected = bruteForce(spec);
      const actual = solve(spec);
      assert.equal(
        actual.status,
        expected.status,
        `status mismatch for n=${n} seed=${seed}: ${JSON.stringify(spec)}`,
      );
      if (expected.status === "SAT") {
        assert.equal(actual.makespan, expected.makespan, `makespan mismatch for n=${n} seed=${seed}`);
        assert.deepEqual(actual.plan, expected.plan, `plan mismatch for n=${n} seed=${seed}`);
      }
    }
  }
});

test("brute force agrees on the tie-break fixture", () => {
  const spec = {
    machines: 2,
    memoryLimit: 10,
    steps: [
      { id: "a", params: ["v0"], memory: 1, duration: 1 },
      { id: "b", params: ["v0"], memory: 1, duration: 1 },
    ],
    edges: [],
  };
  const b = bruteForce(spec);
  const s = solve(spec);
  assert.equal(b.status, "SAT");
  assert.deepEqual(s.plan, b.plan);
});
