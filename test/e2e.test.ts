import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { parseInput } from "../src/model";
import { buildPlan } from "../src/plan";
import { execute } from "../src/cli";

const sample = JSON.parse(readFileSync("examples/sample.json", "utf8"));

test("e2e: sample instance produces a verified certificate", () => {
  const cert = buildPlan(parseInput(sample), true);
  assert.equal(cert.cover.feasible, true);
  // gaps are [6,19] and [25,30]
  assert.deepEqual(cert.cover.gaps, [[6, 19], [25, 30]]);
  // 6..12 bundle (a1+a2, 16 bytes) + 13..26 (c, 9) + 25..30 (d, 5)
  assert.equal(cert.cover.totalBytes, 30);
  assert.equal(cert.cover.packageCount, 4);
  // base-dict is pulled in only by the dependency closure
  assert.deepEqual(cert.dependencyClosure.addedBundles, ["0..5"]);
  const s = cert.schedule!;
  // peak: decode of the a-bundle needs base-dict's dictionary resident:
  // 6 (resident) + 16 (bytes) + 5 (dict) = 27, which equals the lower bound.
  assert.equal(s.peakMemory, 27);
  assert.equal(s.lowerBound, 27);
  assert.ok(s.peakMemory <= s.upperBound);
  assert.equal(s.withinLimit, true);
  // dependencies decode before dependents
  const pos = new Map(s.order.map((k, i) => [k, i]));
  assert.ok(pos.get("0..5")! < pos.get("6..12")!);
  assert.ok(pos.get("13..26")! < pos.get("25..30")!);
  // the step log is exactly the execution order
  assert.deepEqual(s.steps.map((st) => st.bundle), s.order);
  // every step stays within the reported peak and the memory limit
  for (const st of s.steps) assert.ok(st.memPeak <= 27 && st.memPeak <= 40);
  // independent verifiers agree with the DP
  assert.equal(cert.verification.coverBruteForce!.matchesDP, true);
  assert.equal(cert.verification.scheduleExhaustive!.matchesDP, true);
});

test("e2e: memory limit violation is reported, not hidden", () => {
  const tight = { ...sample, memoryLimit: 20 };
  const cert = buildPlan(parseInput(tight), true);
  assert.equal(cert.schedule!.peakMemory, 27);
  assert.equal(cert.schedule!.withinLimit, false);
});

test("e2e: CLI entry produces summary, certificate file and exit code", () => {
  const out = "/tmp/sync-plan-cert.json";
  const res = execute(["examples/sample.json", "-o", out]);
  assert.ok(res.summary.includes("peak=27"));
  assert.ok(res.summary.includes("MATCHES DP"));
  assert.equal(res.exitCode, 0);
  assert.equal(res.certificatePath, out);
  const cert = JSON.parse(readFileSync(out, "utf8"));
  assert.equal(cert.cover.totalBytes, 30);
  assert.equal(cert.schedule.peakMemory, 27);
});

test("e2e: CLI exit code reflects infeasible cover and exceeded memory", () => {
  const infeasible = { existing: [], packages: [
    { id: "a", cover: [0, 1], bytes: 1, dict: 0 },
    { id: "b", cover: [5, 6], bytes: 1, dict: 0 },
  ], maxPackages: 1 };
  writeFileSync("/tmp/sync-plan-infeasible.json", JSON.stringify(infeasible));
  assert.equal(execute(["/tmp/sync-plan-infeasible.json"]).exitCode, 1);
  const tight = { ...sample, memoryLimit: 20 };
  writeFileSync("/tmp/sync-plan-tight.json", JSON.stringify(tight));
  assert.equal(execute(["/tmp/sync-plan-tight.json"]).exitCode, 1);
});

test("input validation rejects malformed requests", () => {
  assert.throws(() => parseInput({ existing: [], packages: [] }), /non-empty/);
  assert.throws(
    () => parseInput({ existing: [], packages: [{ id: "a", cover: [5, 2], bytes: 1, dict: 1 }] }),
    /start > end/,
  );
  assert.throws(
    () => parseInput({
      existing: [],
      packages: [
        { id: "a", cover: [0, 1], bytes: 1, dict: 1 },
        { id: "a", cover: [0, 1], bytes: 1, dict: 1 },
      ],
    }),
    /duplicate/,
  );
  assert.throws(
    () => parseInput({ existing: [], packages: [{ id: "a", cover: [0, 1], bytes: 1, dict: 1, deps: ["ghost"] }] }),
    /unknown package/,
  );
  const ok = parseInput({ existing: [], packages: [{ id: "a", cover: [0, 1], bytes: 1, dict: 1 }] });
  assert.equal(ok.maxPackages, 20); // documented default
  assert.equal(ok.memoryLimit, null);
});
