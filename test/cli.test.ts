import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runCli } from "../src/app.js";

const DEMO = "examples/demo.json";

test("cli plans the demo fixture end to end", () => {
  const result = runCli([DEMO]);
  assert.equal(result.exitCode, 0, result.stderr);
  const report = JSON.parse(result.stdout);

  assert.deepEqual(report.selection, { count: 2, sampleIds: ["T1", "T2"] });
  const sorted = [...report.selection.sampleIds].sort();
  assert.deepEqual(report.selection.sampleIds, sorted);

  assert.equal(report.equivalentPairs.length, 1);
  assert.deepEqual(report.equivalentPairs[0].strategies, ["D", "E"]);
  assert.match(report.equivalentPairs[0].evidence.reason, /identical outputs/);
  assert.deepEqual(report.equivalentPairs[0].evidence.sharedOutputs, [2, 2, 1, 0, 2]);

  assert.deepEqual(report.summary.uselessSampleIds, ["T4"]);
  assert.deepEqual(report.summary.interchangeableSampleGroups, [["T1", "T5"]]);
  assert.equal(report.summary.distinguishablePairCount, 9);
  assert.equal(report.summary.equivalentPairCount, 1);

  assert.equal(report.verification.method, "independent-subset-enumeration");
  assert.equal(report.verification.status, "confirmed");
  assert.equal(report.verification.enumeratedMinimumSize, 2);
});

test("cli reads the problem from stdin with --stdin", () => {
  const input = readFileSync(DEMO, "utf8");
  const result = runCli(["--stdin"], input);
  assert.equal(result.exitCode, 0, result.stderr);
  const report = JSON.parse(result.stdout);
  assert.deepEqual(report.selection.sampleIds, ["T1", "T2"]);
});

test("cli rejects input beyond the 20-strategy limit", () => {
  const strategies = Array.from({ length: 21 }, (_, i) => ({
    id: `S${i}`,
    outputs: [i],
  }));
  const result = runCli(["--stdin"], JSON.stringify({ samples: [{ id: "T1" }], strategies }));
  assert.equal(result.exitCode, 1);
  assert.match(result.stderr, /too many strategies: 21 \(maximum 20\)/);
});

test("cli rejects invalid JSON and missing input", () => {
  const badJson = runCli(["--stdin"], "{not json");
  assert.equal(badJson.exitCode, 1);
  assert.match(badJson.stderr, /invalid JSON/);

  const noInput = runCli([]);
  assert.equal(noInput.exitCode, 1);
  assert.match(noInput.stderr, /Usage: test-planner/);

  const missing = runCli(["does-not-exist.json"]);
  assert.equal(missing.exitCode, 1);
  assert.match(missing.stderr, /cannot read does-not-exist\.json/);
});

test("cli exits with status 2 when verification is inconclusive", () => {
  const result = runCli([DEMO, "--verify-limit", "1"]);
  assert.equal(result.exitCode, 2);
  const report = JSON.parse(result.stdout);
  assert.equal(report.verification.status, "inconclusive");
});

test("cli prints usage with --help", () => {
  const result = runCli(["--help"]);
  assert.equal(result.exitCode, 0);
  assert.match(result.stdout, /Usage: test-planner/);
});
