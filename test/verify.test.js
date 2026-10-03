import test from "node:test";
import assert from "node:assert/strict";
import { solve } from "../src/solver.js";
import { verify } from "../src/verify.js";

const spec = () => ({
  machines: 2,
  memoryLimit: 5,
  steps: [
    { id: "a", params: ["v0", "v1"], memory: 2, duration: 2 },
    { id: "b", params: ["v0", "v1"], memory: 2, duration: 1 },
    { id: "c", params: ["v0"], memory: 3, duration: 1 },
  ],
  edges: [["a", "b"], ["b", "c"]],
  compat: { "a>b": { v0: ["v0", "v1"], v1: ["v1"] } },
});

test("a genuine certificate verifies", () => {
  const s = spec();
  const r = solve(s);
  assert.equal(r.status, "SAT");
  const v = verify(s, r.certificate);
  assert.equal(v.status, "VERIFIED");
  assert.equal(v.result, "SAT");
  assert.equal(v.makespan, r.makespan);
});

test("UNSAT and PENDING certificates verify structurally", () => {
  const unsat = solve({
    machines: 1,
    memoryLimit: 1,
    steps: [{ id: "a", params: ["v0"], memory: 9 }],
    edges: [],
  });
  assert.equal(unsat.status, "UNSAT");
  assert.equal(verify({ machines: 1, memoryLimit: 1, steps: [{ id: "a", params: ["v0"], memory: 9 }], edges: [] }, unsat.certificate).status, "VERIFIED");

  const pending = solve(spec(), { maxNodes: 0 });
  assert.equal(pending.status, "PENDING");
  assert.equal(verify(spec(), pending.certificate).status, "VERIFIED");
});

test("a tampered decision is rejected", () => {
  const s = spec();
  const cert = JSON.parse(JSON.stringify(solve(s).certificate));
  const decision = cert.entries.find((e) => e.type === "decision");
  decision.start += 1;
  const v = verify(s, cert);
  assert.equal(v.status, "INVALID");
  assert.match(v.reason, /hash chain/);
});

test("a forged head is rejected", () => {
  const s = spec();
  const cert = JSON.parse(JSON.stringify(solve(s).certificate));
  cert.head = cert.head.replace(/^./, cert.head[0] === "a" ? "b" : "a");
  assert.equal(verify(s, cert).status, "INVALID");
});

test("a certificate for a different spec is rejected", () => {
  const cert = solve(spec()).certificate;
  const other = spec();
  other.memoryLimit = 6;
  const v = verify(other, cert);
  assert.equal(v.status, "INVALID");
  assert.match(v.reason, /specHash/);
});

test("a truncated certificate is rejected", () => {
  const s = spec();
  const cert = JSON.parse(JSON.stringify(solve(s).certificate));
  cert.entries.pop();
  assert.equal(verify(s, cert).status, "INVALID");
});

test("a fabricated UNSAT claim is rejected", () => {
  const s = spec();
  const cert = JSON.parse(JSON.stringify(solve(s).certificate));
  cert.result = { status: "UNSAT" };
  const v = verify(s, cert);
  assert.equal(v.status, "INVALID");
  assert.match(v.reason, /complete SAT plan/);
});
