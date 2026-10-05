import test from "node:test";
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { runCommand } from "../src/cli.js";

test("cli plan + verify round-trip on lights", () => {
  const plan = runCommand("plan", ["examples/lights.json"]) as {
    length: number;
    plan: number[];
    certificate: { valid: boolean; minimal: boolean };
  };
  assert.equal(plan.length, 4);
  assert.equal(plan.certificate.valid, true);
  assert.equal(plan.certificate.minimal, true);
  const certPath = "/tmp/bitplanner-cert.json";
  writeFileSync(certPath, JSON.stringify({ plan: plan.plan }));
  const v = runCommand("verify", ["examples/lights.json", certPath]) as {
    ok: boolean;
    minimal: boolean;
  };
  assert.equal(v.ok, true);
  assert.equal(v.minimal, true);
});

test("cli verify rejects a non-minimal or invalid certificate", () => {
  const badPath = "/tmp/bitplanner-bad-cert.json";
  writeFileSync(badPath, JSON.stringify({ plan: [4, 0, 1, 2, 3] })); // reset detour
  const v = runCommand("verify", ["examples/lights.json", badPath]) as {
    ok: boolean;
    minimal: boolean;
    goalReached: boolean;
  };
  assert.equal(v.goalReached, true);
  assert.equal(v.minimal, false);
  assert.equal(v.ok, false);
});

test("cli closure on lights lists all 5 reachable states", () => {
  const c = runCommand("closure", ["examples/lights.json"]) as { count: number };
  assert.equal(c.count, 5);
});

test("cli bound on lights is 4", () => {
  const b = runCommand("bound", ["examples/lights.json"]) as { lowerBound: number };
  assert.equal(b.lowerBound, 4);
});

test("cli astar on rocket finds length 4 with bound records", () => {
  const r = runCommand("astar", ["examples/rocket.json"]) as {
    length: number;
    bounds: unknown[];
  };
  assert.equal(r.length, 4);
  assert.ok(r.bounds.length > 0);
});

test("cli iddfs on rocket matches the optimum", () => {
  const r = runCommand("iddfs", ["examples/rocket.json"]) as { length: number };
  assert.equal(r.length, 4);
});

test("cli frontier pause/resume keeps the visit order identical", () => {
  const full = runCommand("frontier", ["examples/rocket.json"]) as {
    visitOrder: string[];
  };
  const snapPath = "/tmp/bitplanner-snap.json";
  runCommand("frontier", ["examples/rocket.json", "--pause", "2", "--out", snapPath]);
  const resumed = runCommand("frontier", ["examples/rocket.json", "--resume", snapPath]) as {
    visitOrder: string[];
  };
  assert.deepEqual(resumed.visitOrder, full.visitOrder);
});
