import assert from "node:assert/strict";
import test from "node:test";
import { AlertEngine } from "../src/alertEngine.ts";
import { evaluateTickByTick } from "../src/reference.ts";
import { SeriesStore } from "../src/series.ts";
import type { SeriesEvent } from "../src/types.ts";

// Deterministic RNG (LCG), no external dependencies.
function makeRng(seed: number) {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 0x100000000;
  };
}

function randomBatch(rng: () => number, maxTick: number): SeriesEvent[] {
  const size = 1 + Math.floor(rng() * 4);
  const events: SeriesEvent[] = [];
  for (let i = 0; i < size; i += 1) {
    const tick = Math.floor(rng() * maxTick);
    const roll = rng();
    if (roll < 0.55) {
      events.push({ kind: "observation", tick, value: Math.floor(rng() * 12) });
    } else if (roll < 0.85) {
      events.push({ kind: "correction", tick, value: Math.floor(rng() * 12) });
    } else {
      events.push({ kind: "missing", tick });
    }
  }
  return events;
}

test("引擎输出与逐 tick 模型逐步对照(随机事件流,含迟到与更正)", () => {
  for (const [seed, threshold, minDuration, maxTick] of [
    [1, 5, 3, 60],
    [42, 7, 2, 40],
    [7, 3, 4, 80],
  ] as const) {
    const rng = makeRng(seed);
    const engine = new AlertEngine(threshold, minDuration);
    const mirror = new SeriesStore();
    let raisedCount = 0;
    let retractedCount = 0;
    for (let round = 0; round < 60; round += 1) {
      const batch = randomBatch(rng, maxTick);
      const events = engine.ingest(batch);
      mirror.apply(batch);
      for (const event of events) {
        if (event.type === "raised") raisedCount += 1;
        if (event.type === "retracted") retractedCount += 1;
      }
      // 每一轮之后,引擎的活动告警必须与逐 tick 参照模型完全一致
      const reference = evaluateTickByTick(mirror, threshold, minDuration);
      assert.deepEqual(engine.activeAlerts(), reference);
    }
    // 活动告警数 = 升起数 - 撤回数
    assert.equal(engine.activeAlerts().length, raisedCount - retractedCount);
  }
});

test("对照:同 tick 混合事件批次下两模型一致", () => {
  const engine = new AlertEngine(5, 2);
  const mirror = new SeriesStore();
  const batches: SeriesEvent[][] = [
    [
      { kind: "observation", tick: 1, value: 9 },
      { kind: "correction", tick: 1, value: 0 },
      { kind: "observation", tick: 2, value: 9 },
    ],
    [
      { kind: "correction", tick: 1, value: 8 },
      { kind: "missing", tick: 2 },
    ],
    [
      { kind: "observation", tick: 2, value: 7 },
      { kind: "missing", tick: 2 },
      { kind: "observation", tick: 3, value: 6 },
    ],
  ];
  for (const batch of batches) {
    engine.ingest(batch);
    mirror.apply(batch);
    assert.deepEqual(
      engine.activeAlerts(),
      evaluateTickByTick(mirror, 5, 2),
    );
  }
});
