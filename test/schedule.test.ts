import test from "node:test";
import { deepEqual, equal, ok } from "node:assert/strict";
import type { Problem } from "../src/model.js";
import { planUpgrade } from "../src/planner.js";
import { buildCertificate } from "../src/schedule.js";

const prob: Problem = {
  source: "v1",
  target: "v3",
  spaceLimitBytes: 300,
  packages: [
    { id: "pa", from: "v1", to: "v2", bytes: 120 },
    { id: "pb", from: "v2", to: "v3", bytes: 250 },
  ],
};

test("证书逐步记录下载/应用/删除，峰值等于路径最大包", () => {
  const plan = planUpgrade(prob);
  ok(plan !== null);
  const cert = buildCertificate(prob, plan);
  ok(cert.ok);
  equal(cert.steps.length, 6);
  deepEqual(cert.steps.map((s) => s.action), ["download", "apply", "delete", "download", "apply", "delete"]);
  equal(cert.peakBytes, 250);
  equal(cert.storedAtEnd, 0);
  equal(cert.finalVersion, "v3");
  equal(cert.totalBytes, 370);
  const afterFirstDownload = cert.steps[0];
  equal(afterFirstDownload.storedBytes, 120);
  equal(afterFirstDownload.peakBytes, 120);
  const afterSecondDownload = cert.steps[3];
  equal(afterSecondDownload.storedBytes, 250);
  equal(afterSecondDownload.peakBytes, 250);
});

test("手工构造超限方案时证书判定失败", () => {
  const badPlan = { packages: prob.packages, totalBytes: 370 };
  const cert = buildCertificate({ ...prob, spaceLimitBytes: 200 }, badPlan);
  ok(!cert.ok);
  ok(cert.problems.some((m) => m.includes("超过上限")));
});

test("包序列断裂时证书判定失败", () => {
  const broken = {
    packages: [
      { id: "pa", from: "v1", to: "v2", bytes: 120 },
      { id: "px", from: "v9", to: "v3", bytes: 100 },
    ],
    totalBytes: 220,
  };
  const cert = buildCertificate(prob, broken);
  ok(!cert.ok);
  ok(cert.problems.some((m) => m.includes("不符")));
});
