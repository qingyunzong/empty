import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { run } from "../src/cli.js";

const CLI = fileURLToPath(new URL("../src/cli.js", import.meta.url));
const SAMPLE = fileURLToPath(new URL("../../examples/sample.json", import.meta.url));

const STDIN_PROBLEM = {
  channels: [{ id: "A", budget: 5 }],
  minImpressions: 3,
  groups: [
    { id: "g1", channel: "A", unitCost: 1, unitImpressions: 1, revenue: [0, 4, 7, 9, 10, 10, 10, 10, 10, 10, 10] },
  ],
};

test("CLI solves the sample and emits a valid budget certificate", () => {
  const res = run([SAMPLE, "--brute"], () => "");
  assert.equal(res.code, 0, res.stderr);
  const cert = JSON.parse(res.stdout);
  assert.equal(cert.status, "optimal");
  assert.equal(cert.allocation.length, 4);
  assert.equal(cert.budgetCertificate.checks.allBudgetsRespected, true);
  assert.equal(cert.budgetCertificate.checks.impressionsSatisfied, true);
  assert.equal(cert.budgetCertificate.checks.amountsWithinRange, true);
  assert.equal(cert.budgetCertificate.checks.allIntegers, true);
  assert.equal(cert.optimality.bruteForce.matches, true);
  assert.equal(typeof cert.fingerprint, "string");
  assert.equal(cert.fingerprint.length, 64);
  const spent = Object.fromEntries(
    cert.budgetCertificate.channels.map((c: { id: string; spent: number }) => [c.id, c.spent]),
  );
  assert.ok(spent.search <= 40);
  assert.ok(spent.social <= 30);
});

test("CLI reads the problem from stdin with '-'", () => {
  const res = run(["-"], () => JSON.stringify(STDIN_PROBLEM));
  assert.equal(res.code, 0, res.stderr);
  const cert = JSON.parse(res.stdout);
  assert.equal(cert.status, "optimal");
  assert.equal(cert.objective.revenue, 10);
  assert.equal(cert.objective.cost, 4);
});

test("CLI exits 1 with an infeasible certificate when unsatisfiable", () => {
  const problem = {
    channels: [{ id: "A", budget: 1 }],
    minImpressions: 100,
    groups: [
      { id: "g1", channel: "A", unitCost: 1, unitImpressions: 1, revenue: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10] },
    ],
  };
  const dir = mkdtempSync(join(tmpdir(), "planner-"));
  const file = join(dir, "infeasible.json");
  writeFileSync(file, JSON.stringify(problem));
  const res = run([file], () => "");
  assert.equal(res.code, 1);
  const cert = JSON.parse(res.stdout);
  assert.equal(cert.status, "infeasible");
  assert.equal(cert.budgetCertificate.impressions.satisfied, false);
});

test("CLI exits 2 on invalid input and on bad usage", () => {
  const bad = run(["-"], () => JSON.stringify({ channels: [], minImpressions: -3, groups: [] }));
  assert.equal(bad.code, 2);
  assert.ok(bad.stderr.includes("invalid input"));
  assert.equal(run([], () => "").code, 2);
  assert.equal(run(["--nope"], () => "").code, 2);
});

test("end-to-end: compiled CLI runs as a child process and writes --out file", () => {
  // 本沙箱会吞掉孙进程的 stdout 管道，因此通过 --out 文件回收输出。
  const dir = mkdtempSync(join(tmpdir(), "planner-e2e-"));
  const out = join(dir, "cert.json");
  const res = spawnSync(process.execPath, [CLI, SAMPLE, "--brute", "--out", out], { encoding: "utf8" });
  assert.equal(res.status, 0, res.stderr);
  const cert = JSON.parse(readFileSync(out, "utf8"));
  assert.equal(cert.status, "optimal");
  assert.equal(cert.optimality.bruteForce.matches, true);
  assert.equal(cert.budgetCertificate.checks.allBudgetsRespected, true);
});
