import { test } from "node:test";
import assert from "node:assert/strict";
import { enumerateAndCheck } from "../src/verify.js";

test("exhaustive small DAG check: n=4, priorities {0,1,2}, all cancel sets", () => {
  const report = enumerateAndCheck(4, { priorityValues: [0, 1, 2] });
  assert.equal(report.dagCount, 64);
  assert.equal(report.instances, 64 * 3 ** 4 * 2 ** 4);
  assert.deepEqual(report.failures, [], report.failures.slice(0, 5).join("\n"));
});

test("exhaustive small DAG check: n=5, priorities {0,1}, cancel size <= 1", () => {
  const report = enumerateAndCheck(5, { priorityValues: [0, 1], maxCancelSize: 1 });
  assert.equal(report.dagCount, 1024);
  assert.equal(report.instances, 1024 * 2 ** 5 * (1 + 5));
  assert.deepEqual(report.failures, [], report.failures.slice(0, 5).join("\n"));
});
