import test from "node:test";
import assert from "node:assert/strict";
import { createEngine } from "../src/engine.js";

function run(engine, events) {
  return events.flatMap((event) => engine.processEvent(event));
}

test("invalid range end <= start is rejected with INVALID_RANGE", () => {
  const engine = createEngine();
  const actions = engine.processEvent({ type: "BATCH", op: "UPSERT", batchId: "b1", start: 10, end: 10, version: 1 });
  assert.equal(actions[0].action, "INVALID_RANGE");
  const actions2 = engine.processEvent({ type: "BATCH", op: "UPSERT", batchId: "b1", start: 20, end: 10, version: 1 });
  assert.equal(actions2[0].action, "INVALID_RANGE");
});

test("quality outside [0,1] is rejected with INVALID_QUALITY", () => {
  const engine = createEngine();
  const bad = engine.processEvent({ type: "READ_METRIC", metricId: "m1", batchId: "b1", ts: 5, yield: 1, quality: 1.5 });
  assert.equal(bad[0].action, "INVALID_QUALITY");
  const negative = engine.processEvent({ type: "READ_METRIC", metricId: "m2", batchId: "b1", ts: 5, yield: 1, quality: -0.1 });
  assert.equal(negative[0].action, "INVALID_QUALITY");
  const ok = engine.processEvent({ type: "READ_METRIC", metricId: "m3", batchId: "b1", ts: 5, yield: 1, quality: 0.5 });
  assert.equal(ok[0].action, "ADD");
});

test("retract of unknown batch reports UNKNOWN_RETRACT", () => {
  const engine = createEngine();
  const actions = engine.processEvent({ type: "BATCH", op: "RETRACT", batchId: "ghost", version: 1 });
  assert.equal(actions[0].action, "UNKNOWN_RETRACT");
});

test("lower or equal version overwrite reports STALE_VERSION", () => {
  const engine = createEngine();
  engine.processEvent({ type: "BATCH", op: "UPSERT", batchId: "b1", start: 0, end: 100, version: 2 });
  const stale = engine.processEvent({ type: "BATCH", op: "UPSERT", batchId: "b1", start: 0, end: 50, version: 1 });
  assert.equal(stale[0].action, "STALE_VERSION");
  const equal = engine.processEvent({ type: "BATCH", op: "UPSERT", batchId: "b1", start: 0, end: 50, version: 2 });
  assert.equal(equal[0].action, "STALE_VERSION");
  const staleRetract = engine.processEvent({ type: "BATCH", op: "RETRACT", batchId: "b1", version: 1 });
  assert.equal(staleRetract[0].action, "STALE_VERSION");
});

test("interval history is kept per batchId across versions", () => {
  const engine = createEngine();
  run(engine, [
    { type: "BATCH", op: "UPSERT", batchId: "b1", start: 0, end: 100, version: 1 },
    { type: "BATCH", op: "UPSERT", batchId: "b1", start: 0, end: 60, version: 2 },
    { type: "BATCH", op: "UPSERT", batchId: "b1", start: 10, end: 60, version: 3 },
  ]);
  const cert = engine.certificate();
  assert.deepEqual(cert.batches[0].versions, [1, 2, 3]);
  assert.equal(cert.batches[0].version, 3);
});

test("retract withdraws matched metrics and a later upsert revives the batch", () => {
  const engine = createEngine();
  run(engine, [
    { type: "BATCH", op: "UPSERT", batchId: "b1", start: 0, end: 100, version: 1 },
    { type: "READ_METRIC", metricId: "m1", batchId: "b1", ts: 10, yield: 1, quality: 0.9 },
  ]);
  const retracted = engine.processEvent({ type: "BATCH", op: "RETRACT", batchId: "b1", version: 2 });
  assert.deepEqual(retracted.map((a) => a.action), ["WITHDRAW"]);
  const revived = engine.processEvent({ type: "BATCH", op: "UPSERT", batchId: "b1", start: 0, end: 100, version: 3 });
  assert.deepEqual(revived.map((a) => a.action), ["ADD"]);
  assert.equal(revived[0].status, "MATCHED");
});

test("watermark only moves forward", () => {
  const engine = createEngine();
  engine.processEvent({ type: "WATERMARK", ts: 100 });
  engine.processEvent({ type: "WATERMARK", ts: 50 });
  assert.equal(engine.watermark, 100);
});

test("certificate lists all member ids, versions and counts", () => {
  const engine = createEngine();
  run(engine, [
    { type: "BATCH", op: "UPSERT", batchId: "b1", start: 0, end: 100, version: 1 },
    { type: "BATCH", op: "UPSERT", batchId: "b2", start: 200, end: 300, version: 1 },
    { type: "READ_METRIC", metricId: "m1", batchId: "b1", ts: 10, yield: 1, quality: 0.9 },
    { type: "READ_METRIC", metricId: "m2", batchId: "b1", ts: 150, yield: 1, quality: 0.9 },
    { type: "READ_METRIC", metricId: "m3", batchId: "b2", ts: 250, yield: 1, quality: 0.9 },
  ]);
  const cert = engine.certificate();
  assert.equal(cert.type, "CERTIFICATE");
  assert.deepEqual(cert.batches.map((b) => b.batchId), ["b1", "b2"]);
  assert.deepEqual(cert.metrics.map((m) => m.metricId), ["m1", "m2", "m3"]);
  assert.deepEqual(cert.counts, { batches: 2, metrics: 3, matched: 2, unmatched: 1 });
});
