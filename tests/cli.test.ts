import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runCli } from "../src/cliCore.js";

// The CLI core is pure: tests inject file/stdin reads instead of spawning
// child processes (the sandbox forbids spawnSync).
function readInput(file: string | null): string {
  if (file === null || file === "-") throw new Error("no stdin provided");
  return readFileSync(file, "utf8");
}

test("cli: feasible example finds the optimum with per-sample evidence", () => {
  const r = runCli(["examples/feasible.json"], readInput);
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /Status: OPTIMAL/);
  assert.match(r.stdout, /Total cost: 4/);
  assert.match(r.stdout, /Selected rules \(2\): r1, r6/);
  assert.match(r.stdout, /s2: expected=deny, actual=deny - deny rule\(s\) \[r6\] override allow rule\(s\) \[r1\] \(deny priority\)/);
  assert.match(r.stdout, /s4: expected=deny, actual=deny - no selected rule matches this sample \(default deny\)/);
  assert.match(r.stdout, /Verification: brute force enumerated 64 subsets; .* OK/);
});

test("cli: --json emits a structured report", () => {
  const r = runCli(["examples/feasible.json", "--json"], readInput);
  assert.equal(r.code, 0, r.stderr);
  const report = JSON.parse(r.stdout);
  assert.equal(report.status, "optimal");
  assert.equal(report.cost, 4);
  assert.deepEqual(
    report.subset.map((s: { id: string }) => s.id),
    ["r1", "r6"],
  );
  assert.equal(report.evidence.length, 4);
  assert.equal(report.verification.agrees, true);
  assert.equal(report.verification.subsetsEvaluated, 64);
});

test("cli: infeasible example exits 1 and brute force agrees", () => {
  const r = runCli(["examples/infeasible.json"], readInput);
  assert.equal(r.code, 1, r.stderr);
  assert.match(r.stdout, /Status: INFEASIBLE/);
  assert.match(r.stdout, /r2: deny rule matches allow-expected sample\(s\): s1/);
  assert.match(r.stdout, /Verification: brute force enumerated 4 subsets; brute force also found no feasible subset\. OK/);
});

test("cli: reads the problem from stdin (file argument '-')", () => {
  const input = JSON.stringify({
    candidates: [{ id: "r1", cost: 7, effect: "allow", matches: ["s1"] }],
    samples: [{ id: "s1", expect: "allow" }],
  });
  const r = runCli(["-"], () => input);
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /Total cost: 7/);
});

test("cli: --solver brute produces the same optimum", () => {
  const r = runCli(["examples/feasible.json", "--solver", "brute"], readInput);
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /Total cost: 4/);
});

test("cli: --no-verify skips the brute-force cross-check", () => {
  const r = runCli(["examples/feasible.json", "--no-verify"], readInput);
  assert.equal(r.code, 0, r.stderr);
  assert.ok(!r.stdout.includes("Verification:"));
});

test("cli: rejects more than 18 candidates", () => {
  const input = JSON.stringify({
    candidates: Array.from({ length: 19 }, (_, i) => ({ id: `r${i}`, cost: 1, effect: "deny", matches: [] })),
    samples: [],
  });
  const r = runCli([], () => input);
  assert.equal(r.code, 2);
  assert.match(r.stderr, /at most 18 candidates/);
});

test("cli: rejects invalid JSON and unreadable input", () => {
  const bad = runCli([], () => "not json");
  assert.equal(bad.code, 2);
  assert.match(bad.stderr, /not valid JSON/);
  const missing = runCli(["does-not-exist.json"], readInput);
  assert.equal(missing.code, 2);
  assert.match(missing.stderr, /could not read file/);
});
