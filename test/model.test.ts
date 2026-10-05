import test from "node:test";
import assert from "node:assert/strict";
import { canonicalize, InputError, MAX_SAMPLES, MAX_STRATEGIES, parseProblem } from "../src/model";

test("canonicalize is key-order independent and handles nesting", () => {
  assert.equal(canonicalize({ b: 1, a: [2, { d: null, c: "x" }] }), canonicalize({ a: [2, { c: "x", d: null }], b: 1 }));
  assert.notEqual(canonicalize({ a: 1 }), canonicalize({ a: 2 }));
  assert.notEqual(canonicalize([1, 2]), canonicalize([2, 1]));
  assert.equal(canonicalize(null), "null");
});

test("parses array outputs and object outputs identically", () => {
  const viaArray = parseProblem({
    samples: ["s1", "s2"],
    strategies: [
      { id: "A", outputs: [1, "x"] },
      { id: "B", outputs: [2, "x"] },
    ],
  });
  const viaObject = parseProblem({
    samples: ["s1", "s2"],
    strategies: [
      { id: "A", outputs: { s1: 1, s2: "x" } },
      { id: "B", outputs: { s2: "x", s1: 2 } },
    ],
  });
  assert.deepEqual(viaObject, viaArray);
});

test("accepts the documented limits: 20 strategies and 30 samples", () => {
  const problem = parseProblem({
    samples: Array.from({ length: MAX_SAMPLES }, (_, i) => `s${i}`),
    strategies: Array.from({ length: MAX_STRATEGIES }, (_, i) => ({
      id: `P${i}`,
      outputs: Array.from({ length: MAX_SAMPLES }, () => i),
    })),
  });
  assert.equal(problem.strategies.length, 20);
  assert.equal(problem.sampleIds.length, 30);
});

test("rejects more than 20 strategies and more than 30 samples", () => {
  assert.throws(
    () =>
      parseProblem({
        samples: ["s1"],
        strategies: Array.from({ length: 21 }, (_, i) => ({ id: `P${i}`, outputs: [i] })),
      }),
    (error: unknown) => error instanceof InputError && /at most 20 strategies/.test((error as Error).message)
  );
  assert.throws(
    () =>
      parseProblem({
        samples: Array.from({ length: 31 }, (_, i) => `s${i}`),
        strategies: [{ id: "A", outputs: Array.from({ length: 31 }, () => 0) }],
      }),
    (error: unknown) => error instanceof InputError && /at most 30 samples/.test((error as Error).message)
  );
});

test("rejects duplicate ids, missing outputs and unknown samples", () => {
  assert.throws(
    () => parseProblem({ samples: ["s1", "s1"], strategies: [{ id: "A", outputs: [1, 2] }] }),
    /sample ids must be unique/
  );
  assert.throws(
    () =>
      parseProblem({
        samples: ["s1"],
        strategies: [
          { id: "A", outputs: [1] },
          { id: "A", outputs: [2] },
        ],
      }),
    /duplicate strategy id/
  );
  assert.throws(
    () => parseProblem({ samples: ["s1", "s2"], strategies: [{ id: "A", outputs: [1] }] }),
    /outputs array has 1 entries, expected 2/
  );
  assert.throws(
    () => parseProblem({ samples: ["s1", "s2"], strategies: [{ id: "A", outputs: { s1: 1 } }] }),
    /missing output for sample "s2"/
  );
  assert.throws(
    () =>
      parseProblem({ samples: ["s1"], strategies: [{ id: "A", outputs: { s1: 1, sX: 2 } }] }),
    /unknown samples: sX/
  );
  assert.throws(() => parseProblem({ samples: [], strategies: [] }), /at least one sample/);
  assert.throws(() => parseProblem("nope"), /must be a JSON object/);
});
