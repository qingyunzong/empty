import test from "node:test";
import assert from "node:assert/strict";
import { createEngine } from "../src/engine.js";

test("acceptance 1: late-arriving batch flips a metric from UNMATCHED to MATCHED", () => {
  const engine = createEngine();
  const added = engine.processEvent({ type: "READ_METRIC", metricId: "m1", batchId: "b1", ts: 42, yield: 7, quality: 0.9 });
  assert.deepEqual(added.map((a) => [a.action, a.status]), [["ADD", "UNMATCHED"]]);

  const corrected = engine.processEvent({ type: "BATCH", op: "UPSERT", batchId: "b1", start: 0, end: 100, version: 1 });
  assert.deepEqual(corrected.map((a) => [a.action, a.status]), [["ADD", "MATCHED"]]);
  assert.equal(engine.certificate().counts.matched, 1);
});

test("acceptance 2: shrinking a batch excludes the tail metric with cascading WITHDRAW", () => {
  const engine = createEngine();
  engine.processEvent({ type: "BATCH", op: "UPSERT", batchId: "b1", start: 0, end: 100, version: 1 });
  engine.processEvent({ type: "READ_METRIC", metricId: "head", batchId: "b1", ts: 10, yield: 1, quality: 0.9 });
  engine.processEvent({ type: "READ_METRIC", metricId: "tail", batchId: "b1", ts: 90, yield: 1, quality: 0.9 });
  assert.equal(engine.certificate().counts.matched, 2);

  const actions = engine.processEvent({ type: "BATCH", op: "UPSERT", batchId: "b1", start: 0, end: 50, version: 2 });
  assert.deepEqual(actions, [{ type: "ACTION", action: "WITHDRAW", metricId: "tail", batchId: "b1", version: 2 }]);

  const cert = engine.certificate();
  assert.equal(cert.counts.matched, 1);
  assert.deepEqual(cert.metrics.find((m) => m.metricId === "tail").status, "UNMATCHED");
  assert.deepEqual(cert.metrics.find((m) => m.metricId === "head").status, "MATCHED");
});

test("acceptance 3: correction after the metric is frozen is reported LATE and rejected", () => {
  const engine = createEngine();
  engine.processEvent({ type: "BATCH", op: "UPSERT", batchId: "b1", start: 0, end: 200, version: 1 });
  engine.processEvent({ type: "READ_METRIC", metricId: "m1", batchId: "b1", ts: 100, yield: 1, quality: 0.9 });
  engine.processEvent({ type: "WATERMARK", ts: 130 }); // 100 + 30s freeze lag

  const actions = engine.processEvent({ type: "BATCH", op: "UPSERT", batchId: "b1", start: 0, end: 50, version: 2 });
  assert.deepEqual(actions, [{ type: "ACTION", action: "LATE", metricId: "m1", batchId: "b1", version: 2, reason: "METRIC_FROZEN" }]);

  const metric = engine.certificate().metrics.find((m) => m.metricId === "m1");
  assert.equal(metric.status, "MATCHED");
  assert.equal(metric.frozen, true);
});

test("acceptance 3b: frozen metric survives a retract with LATE instead of WITHDRAW", () => {
  const engine = createEngine();
  engine.processEvent({ type: "BATCH", op: "UPSERT", batchId: "b1", start: 0, end: 200, version: 1 });
  engine.processEvent({ type: "READ_METRIC", metricId: "m1", batchId: "b1", ts: 100, yield: 1, quality: 0.9 });
  engine.processEvent({ type: "WATERMARK", ts: 131 });

  const actions = engine.processEvent({ type: "BATCH", op: "RETRACT", batchId: "b1", version: 2 });
  assert.deepEqual(actions.map((a) => a.action), ["LATE"]);
  assert.equal(engine.certificate().metrics[0].status, "MATCHED");
});
