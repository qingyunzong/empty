import test from "node:test";
import assert from "node:assert/strict";
import { solve } from "../src/solver.js";
import { InputError } from "../src/spec.js";

const tieSpec = {
  machines: 2,
  memoryLimit: 10,
  steps: [
    { id: "a", params: ["v0"], memory: 1, duration: 1 },
    { id: "b", params: ["v0"], memory: 1, duration: 1 },
  ],
  edges: [],
};

test("tied optima resolve to the lexicographically smallest plan", () => {
  const r = solve(tieSpec);
  assert.equal(r.status, "SAT");
  assert.equal(r.makespan, 1);
  assert.deepEqual(r.plan, {
    a: { start: 0, machine: 0, param: "v0" },
    b: { start: 0, machine: 1, param: "v0" },
  });
});

test("solver output is deterministic across runs", () => {
  const spec = {
    machines: 2,
    memoryLimit: 4,
    steps: [
      { id: "a", params: ["v0", "v1"], memory: 2, duration: 2 },
      { id: "b", params: ["v0", "v1"], memory: 2, duration: 1 },
      { id: "c", params: ["v0"], memory: 3, duration: 1 },
    ],
    edges: [["a", "b"]],
    compat: { "a>b": { v0: ["v0", "v1"], v1: ["v1"] } },
  };
  const r1 = solve(spec);
  const r2 = solve(spec);
  assert.equal(r1.status, "SAT");
  assert.equal(JSON.stringify(r1), JSON.stringify(r2));
  assert.equal(r1.certificate.head, r2.certificate.head);
});

test("UNSAT when a step exceeds the memory limit", () => {
  const r = solve({ machines: 1, memoryLimit: 2, steps: [{ id: "a", params: ["v0"], memory: 5 }], edges: [] });
  assert.equal(r.status, "UNSAT");
  assert.match(r.certificate.result.reason, /memory/);
});

test("UNSAT when the compat matrix empties a domain", () => {
  const r = solve({
    machines: 1,
    memoryLimit: 10,
    steps: [
      { id: "a", params: ["v0"], memory: 1 },
      { id: "b", params: ["v1"], memory: 1 },
    ],
    edges: [["a", "b"]],
    compat: { "a>b": { v0: [] } },
  });
  assert.equal(r.status, "UNSAT");
});

test("node budget exhaustion yields PENDING with a partial certificate, never UNSAT", () => {
  const spec = {
    machines: 1,
    memoryLimit: 4,
    steps: [
      { id: "a", params: ["v0", "v1"], memory: 1, duration: 2 },
      { id: "b", params: ["v0", "v1"], memory: 1, duration: 2 },
      { id: "c", params: ["v0", "v1"], memory: 1, duration: 2 },
    ],
    edges: [],
  };
  const full = solve(spec);
  assert.equal(full.status, "SAT");
  const r = solve(spec, { maxNodes: 1 });
  assert.equal(r.status, "PENDING");
  assert.notEqual(r.status, "UNSAT");
  assert.ok(Array.isArray(r.certificate.entries));
  assert.ok(r.certificate.entries.length < full.certificate.entries.length);
  assert.equal(r.certificate.result.status, "PENDING");
});

test("certificate byte budget exhaustion yields PENDING", () => {
  const spec = {
    machines: 2,
    memoryLimit: 4,
    steps: [
      { id: "a", params: ["v0"], memory: 1, duration: 1 },
      { id: "b", params: ["v0"], memory: 1, duration: 1 },
    ],
    edges: [],
  };
  const r = solve(spec, { maxCertBytes: 200 });
  assert.equal(r.status, "PENDING");
  assert.ok(r.certificate.entries.length >= 0);
});

test("invalid specs raise InputError", () => {
  assert.throws(() => solve(null), InputError);
  assert.throws(() => solve({ machines: 0, memoryLimit: 1, steps: [{ id: "a", params: ["v"], memory: 1 }] }), InputError);
  assert.throws(
    () => solve({ machines: 1, memoryLimit: 1, steps: [{ id: "a", params: [], memory: 1 }] }),
    InputError,
  );
  assert.throws(
    () =>
      solve({
        machines: 1,
        memoryLimit: 1,
        steps: [
          { id: "a", params: ["v"], memory: 1 },
          { id: "a", params: ["v"], memory: 1 },
        ],
      }),
    InputError,
  );
  assert.throws(
    () =>
      solve({
        machines: 1,
        memoryLimit: 1,
        steps: [
          { id: "a", params: ["v"], memory: 1 },
          { id: "b", params: ["v"], memory: 1 },
        ],
        edges: [["a", "b"], ["b", "a"]],
      }),
    /cycle/,
  );
  assert.throws(
    () =>
      solve({
        machines: 1,
        memoryLimit: 1,
        steps: [{ id: "a", params: ["v"], memory: 1 }],
        edges: [["a", "zzz"]],
      }),
    InputError,
  );
  assert.throws(
    () =>
      solve({
        machines: 1,
        memoryLimit: 1,
        steps: [
          { id: "a", params: ["v"], memory: 1 },
          { id: "b", params: ["v"], memory: 1 },
        ],
        edges: [["a", "b"]],
        compat: { "a>b": { nope: ["v"] } },
      }),
    InputError,
  );
});

test("mutex pairs cannot overlap even on different machines", () => {
  const r = solve({
    machines: 2,
    memoryLimit: 10,
    steps: [
      { id: "a", params: ["v0"], memory: 1, duration: 2 },
      { id: "b", params: ["v0"], memory: 1, duration: 2 },
    ],
    edges: [],
    mutex: [["a", "b"]],
  });
  assert.equal(r.status, "SAT");
  assert.equal(r.makespan, 4);
});
