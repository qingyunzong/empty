import test from "node:test";
import assert from "node:assert/strict";
import { createEngine } from "../src/engine.js";
import { runReference } from "../src/reference.js";

function mulberry32(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function generateEvents(seed, count) {
  const rand = mulberry32(seed);
  const pick = (items) => items[Math.floor(rand() * items.length)];
  const batchIds = ["b1", "b2", "b3"];
  const events = [];
  const versions = new Map(batchIds.map((id) => [id, 0]));
  let metricSeq = 0;
  let watermark = 0;
  for (let i = 0; i < count; i += 1) {
    const roll = rand();
    if (roll < 0.45) {
      metricSeq += 1;
      events.push({
        type: "READ_METRIC",
        metricId: `m${metricSeq}`,
        batchId: pick(batchIds),
        ts: Math.floor(rand() * 200),
        yield: Math.round(rand() * 1000) / 10,
        quality: Math.round(rand() * 100) / 100,
      });
    } else if (roll < 0.75) {
      const batchId = pick(batchIds);
      const version = versions.get(batchId) + 1;
      versions.set(batchId, version);
      const start = Math.floor(rand() * 150);
      events.push({ type: "BATCH", op: "UPSERT", batchId, start, end: start + 1 + Math.floor(rand() * 100), version });
    } else if (roll < 0.85) {
      const batchId = pick(batchIds);
      if (versions.get(batchId) > 0) {
        const version = versions.get(batchId) + 1;
        versions.set(batchId, version);
        events.push({ type: "BATCH", op: "RETRACT", batchId, version });
      }
    } else {
      watermark += Math.floor(rand() * 40);
      events.push({ type: "WATERMARK", ts: watermark });
    }
  }
  return events;
}

for (const seed of [1, 7, 42, 1337, 20261005]) {
  test(`differential: engine matches brute-force reference (seed ${seed})`, () => {
    const events = generateEvents(seed, 120);
    const engine = createEngine();
    const engineActions = [];
    const engineStages = [];
    for (const event of events) {
      engineActions.push(...engine.processEvent(event));
      engineStages.push(engine.snapshot());
    }
    const reference = runReference(events);
    assert.deepEqual(engineActions, reference.actions, "action streams diverge");
    assert.deepEqual(engineStages, reference.stages, "per-stage snapshots diverge");
  });
}

test("reference enumerates metric status at every watermark stage", () => {
  const events = [
    { type: "BATCH", op: "UPSERT", batchId: "b1", start: 0, end: 100, version: 1 },
    { type: "READ_METRIC", metricId: "m1", batchId: "b1", ts: 90, yield: 1, quality: 0.9 },
    { type: "WATERMARK", ts: 50 },
    { type: "BATCH", op: "UPSERT", batchId: "b1", start: 0, end: 50, version: 2 },
    { type: "WATERMARK", ts: 120 },
    { type: "BATCH", op: "UPSERT", batchId: "b1", start: 0, end: 200, version: 3 },
    { type: "WATERMARK", ts: 121 },
  ];
  const { stages } = runReference(events);
  const statusAt = (index) => stages[index].metrics.m1;
  assert.equal(statusAt(1), "MATCHED");   // inside v1 [0,100)
  assert.equal(statusAt(3), "UNMATCHED"); // v2 shrink excludes ts=90, not yet frozen (wm 50 < 120)
  assert.equal(statusAt(5), "UNMATCHED"); // v3 would re-match, but frozen at wm 120 -> LATE, stays UNMATCHED
  assert.equal(stages.at(-1).watermark, 121);
});
