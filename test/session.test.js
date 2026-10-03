import test from "node:test";
import assert from "node:assert/strict";
import { solve } from "../src/solver.js";
import { InputError } from "../src/spec.js";
import {
  initState,
  pin,
  unpin,
  insertJob,
  forkCheckpoint,
  mergeCheckpoint,
  sessionSolve,
  effectiveSpec,
} from "../src/session.js";

const spec = () => ({
  machines: 2,
  memoryLimit: 6,
  steps: [
    { id: "a", params: ["v0", "v1"], memory: 2, duration: 2 },
    { id: "b", params: ["v0", "v1", "v2"], memory: 2, duration: 1 },
    { id: "c", params: ["v0"], memory: 3, duration: 1 },
  ],
  edges: [["a", "b"], ["b", "c"]],
  compat: { "a>b": { v0: ["v0", "v1"], v1: ["v1", "v2"] } },
});

test("pin/unpin is incremental-consistent with a full recompute", () => {
  const state = initState(spec());
  const base = sessionSolve(state);
  const freshBase = solve(spec());
  assert.equal(base.status, "SAT");
  assert.equal(JSON.stringify(base.plan), JSON.stringify(freshBase.plan));
  assert.equal(base.certificate.head, freshBase.certificate.head);

  pin(state, "b", "v2");
  const pinned = sessionSolve(state);
  const freshPinned = solve(effectiveSpec(state));
  assert.equal(JSON.stringify(pinned.plan), JSON.stringify(freshPinned.plan));
  assert.equal(pinned.certificate.head, freshPinned.certificate.head);
  assert.equal(pinned.plan.b.param, "v2");

  unpin(state, "b");
  const restored = sessionSolve(state);
  assert.equal(JSON.stringify(restored.plan), JSON.stringify(freshBase.plan));
  assert.equal(restored.certificate.head, freshBase.certificate.head);
});

test("pin that forces infeasibility matches a fresh UNSAT recompute", () => {
  const state = initState(spec());
  pin(state, "a", "v0");
  pin(state, "b", "v2");
  const r = sessionSolve(state);
  const fresh = solve(effectiveSpec(state));
  assert.equal(r.status, "UNSAT");
  assert.equal(fresh.status, "UNSAT");
  assert.equal(r.certificate.head, fresh.certificate.head);
});

test("pin/unpin validation errors", () => {
  const state = initState(spec());
  assert.throws(() => pin(state, "zzz", "v0"), InputError);
  assert.throws(() => pin(state, "a", "v9"), InputError);
  assert.throws(() => unpin(state, "a"), InputError);
});

test("insert_job extends the DAG and validates input", () => {
  const state = initState(spec());
  insertJob(state, { id: "d", params: ["v0"], memory: 1, duration: 1 }, [["c", "d"]]);
  const r = sessionSolve(state);
  assert.equal(r.status, "SAT");
  assert.ok(r.plan.d.start >= r.plan.c.start + 1);
  assert.throws(() => insertJob(state, { id: "d", params: ["v0"], memory: 1 }), InputError);
  assert.throws(() => insertJob(state, { id: "e", params: ["v0"], memory: 1 }, [["c", "a"]]), InputError);
  assert.throws(
    () => insertJob(state, { id: "f", params: ["v0"], memory: 1 }, [["f", "f"]]),
    InputError,
  );
});

test("merge of prefix-consistent checkpoints fast-forwards", () => {
  const state = initState(spec());
  pin(state, "b", "v1");
  forkCheckpoint(state, "exp");
  const r = mergeCheckpoint(state, "main", "exp");
  assert.equal(r.status, "OK");
  assert.equal(state.branches.exp.entries.length, state.branches.main.entries.length);
  assert.equal(state.branches.exp.head, state.branches.main.head);
});

test("merge of diverged histories returns CONFLICT with the earliest divergence", () => {
  const state = initState(spec());
  pin(state, "a", "v0");
  forkCheckpoint(state, "exp");
  pin(state, "b", "v1", "main");
  pin(state, "b", "v2", "exp");
  const r = mergeCheckpoint(state, "main", "exp");
  assert.equal(r.status, "CONFLICT");
  assert.equal(r.divergence.index, 1);
  assert.equal(r.divergence.src.entry.param, "v1");
  assert.equal(r.divergence.dst.entry.param, "v2");
  assert.equal(r.divergence.src.entry.step, "b");
});

test("fork validation errors", () => {
  const state = initState(spec());
  forkCheckpoint(state, "exp");
  assert.throws(() => forkCheckpoint(state, "exp"), InputError);
  assert.throws(() => forkCheckpoint(state, "x", "nope"), InputError);
  assert.throws(() => mergeCheckpoint(state, "exp", "nope"), InputError);
});
