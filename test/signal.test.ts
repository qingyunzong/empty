import { test } from "node:test";
import assert from "node:assert/strict";
import { SignalSeries, type Checkpoint } from "../src/signal.js";
import { runReference, type ReferenceEvent } from "../src/reference.js";
import { Rational } from "../src/rational.js";

const CONFIG = { k: 3, period: 4 } as const;

function avg(series: SignalSeries): string | null {
  const value = series.average();
  return value === null ? null : value.toString();
}

test("weighted average of the most recent k valid samples", () => {
  const s = new SignalSeries({ k: 2, period: 100 });
  s.appendSample(2, 1);
  s.appendSample(4, 1);
  s.appendSample(8, 1);
  // Window = slots {1, 2}; effective weights 101/100 and 102/100.
  assert.deepEqual(s.windowIndices(), [1, 2]);
  assert.equal(avg(s), "1220/203");
  assert.equal(s.isWindowClosed(), true);
});

test("missing slots occupy time positions but carry no weight", () => {
  const s = new SignalSeries(CONFIG);
  s.appendSample(1, 1); // slot 0
  s.appendMissing(); // slot 1: position kept, no weight
  s.appendSample(2, 1); // slot 2
  s.appendSample(3, 1); // slot 3
  assert.equal(s.slotKind(1), "missing");
  assert.deepEqual(s.windowIndices(), [0, 2, 3]);
  // Phase of slot 2 still uses time position 2, not a compacted index.
  assert.equal(s.effectiveWeightAt(2).toString(), "3/4");
  assert.equal(avg(s), "29/12");
});

test("all-zero weights return empty", () => {
  const s = new SignalSeries({ k: 2, period: 2 });
  assert.equal(s.average(), null); // no samples at all
  s.appendMissing();
  assert.equal(s.average(), null); // only missing slots
  s.appendSample(5, 0);
  s.appendSample(7, 0);
  assert.equal(s.average(), null); // every weight in the window is zero
  s.appendSample(4, 1);
  // Window = {zero-weight slot 1, slot 2}; zero-weight sample contributes nothing.
  assert.equal(avg(s), "4");
});

test("effective weights combine time phase and gap distance", () => {
  const s = new SignalSeries(CONFIG);
  s.appendSample(1, 1); // 0
  s.appendMissing(); // 1
  s.appendSample(2, 1); // 2
  s.appendSample(3, 1); // 3
  // effW(i) = weight * (period + i mod period) / (period * (1 + gapBefore + gapAfter))
  assert.equal(s.effectiveWeightAt(0).toString(), "1/2"); // phase 4/4, gapAfter 1
  assert.equal(s.effectiveWeightAt(2).toString(), "3/4"); // phase 6/4, gapBefore 1
  assert.equal(s.effectiveWeightAt(3).toString(), "7/4"); // phase 7/4, no gaps
});

test("deleting a sample changes subsequent windows and adjacent weights", () => {
  const s = new SignalSeries(CONFIG);
  s.appendSample(1, 1); // 0
  s.appendMissing(); // 1
  s.appendSample(2, 1); // 2
  s.appendSample(3, 1); // 3
  assert.equal(avg(s), "29/12");

  s.delete(2); // slot 2 becomes missing
  assert.equal(s.slotKind(2), "missing");
  // Window membership changes: {0,2,3} -> {0,3}.
  assert.deepEqual(s.windowIndices(), [0, 3]);
  // Adjacent weights are re-weighted by the widened gap.
  assert.equal(s.effectiveWeightAt(0).toString(), "1/3"); // was 1/2
  assert.equal(s.effectiveWeightAt(3).toString(), "7/12"); // was 7/4
  assert.equal(avg(s), "25/11");
});

test("corrections and deletions match direct fraction recomputation", () => {
  const events: ReferenceEvent[] = [
    { op: "sample", value: 3, weight: 2 },
    { op: "sample", value: "1.5", weight: 1 },
    { op: "missing" },
    { op: "sample", value: -2, weight: 4 },
    { op: "sample", value: 0, weight: 0 },
    { op: "query" },
    { op: "correct", index: 1, value: 5, weight: 3 },
    { op: "query" },
    { op: "delete", index: 0 },
    { op: "query" },
    { op: "sample", value: 7, weight: 1 },
    { op: "missing" },
    { op: "missing" },
    { op: "sample", value: 1, weight: 2 },
    { op: "query" },
    { op: "correct", index: 3, value: 10, weight: 0 },
    { op: "query" },
  ];
  const s = new SignalSeries({ k: 3, period: 5 });
  const expected = runReference(events, { k: 3, period: 5 });
  let queries = 0;
  for (const event of events) {
    applyEvent(s, event);
    if (event.op === "query") {
      const want = expected[queries++];
      if (want === undefined) throw new Error("missing expected value");
      assert.equal(avg(s), want === null ? null : want.toString(), `query #${queries}`);
    }
  }
  assert.ok(queries >= 5);
});

test("checkpoint pause/resume carries the unclosed window and source summary", () => {
  const config = { k: 4, period: 3 };
  const before: ReferenceEvent[] = [
    { op: "sample", value: 2, weight: 3 },
    { op: "missing" },
    { op: "sample", value: 6, weight: 1 },
    // Window is unclosed here: only 2 of k=4 valid samples.
  ];
  const after: ReferenceEvent[] = [
    { op: "sample", value: 1, weight: 5 },
    { op: "missing" },
    { op: "missing" },
    { op: "sample", value: 9, weight: 2 },
    { op: "sample", value: 4, weight: 4 },
    { op: "delete", index: 2 },
    { op: "sample", value: 8, weight: 1 },
    { op: "query" },
  ];

  const uninterrupted = new SignalSeries(config);
  for (const event of [...before, ...after]) applyEvent(uninterrupted, event);

  const paused = new SignalSeries(config);
  for (const event of before) applyEvent(paused, event);
  assert.equal(paused.isWindowClosed(), false);

  const checkpoint = paused.checkpoint();
  assert.equal(checkpoint.window.closed, false);
  assert.deepEqual(checkpoint.window.indices, [0, 2]);
  assert.equal(checkpoint.sourceSummary.sampleCount, 2);
  assert.equal(checkpoint.sourceSummary.missingCount, 1);
  assert.equal(checkpoint.sourceSummary.nextIndex, 3);

  // Checkpoints survive a JSON round-trip (pausing to disk and resuming).
  const revived = SignalSeries.resume(JSON.parse(JSON.stringify(checkpoint)) as Checkpoint);
  assert.deepEqual(revived.checkpoint(), checkpoint);
  for (const event of after) applyEvent(revived, event);

  assert.equal(avg(revived), avg(uninterrupted));
  assert.deepEqual(revived.windowIndices(), uninterrupted.windowIndices());
});

test("resume rejects a tampered or incomplete checkpoint", () => {
  const s = new SignalSeries({ k: 2, period: 2 });
  s.appendSample(1, 1);
  s.appendMissing();
  s.appendSample(2, 2);
  const checkpoint = s.checkpoint();

  const badChecksum = JSON.parse(JSON.stringify(checkpoint)) as Checkpoint;
  (badChecksum.sourceSummary as { checksum: string }).checksum = "0".repeat(64);
  assert.throws(() => SignalSeries.resume(badChecksum), /source summary/);

  const badWindow = JSON.parse(JSON.stringify(checkpoint)) as Checkpoint;
  (badWindow.window as { indices: number[] }).indices = [0];
  assert.throws(() => SignalSeries.resume(badWindow), /window/);

  const noWindow = JSON.parse(JSON.stringify(checkpoint)) as Record<string, unknown>;
  delete noWindow["window"];
  assert.throws(() => SignalSeries.resume(noWindow as unknown as Checkpoint), /window|summary/);

  const noSummary = JSON.parse(JSON.stringify(checkpoint)) as Record<string, unknown>;
  delete noSummary["sourceSummary"];
  assert.throws(() => SignalSeries.resume(noSummary as unknown as Checkpoint), /window|summary/);
});

test("branch corrections keep the old view and match the full resample model", () => {
  const config = { k: 3, period: 4 };
  const base: ReferenceEvent[] = [
    { op: "sample", value: 1, weight: 1 },
    { op: "sample", value: 2, weight: 2 },
    { op: "missing" },
    { op: "sample", value: 3, weight: 3 },
    { op: "sample", value: 4, weight: 1 },
  ];
  const original = new SignalSeries(config);
  for (const event of base) applyEvent(original, event);
  const viewBefore = {
    average: avg(original),
    window: [...original.windowIndices()],
    weights: [0, 1, 3, 4].map((i) => original.effectiveWeightAt(i).toString()),
  };

  const forkEvents: ReferenceEvent[] = [
    { op: "correct", index: 1, value: 20, weight: 5 },
    { op: "delete", index: 3 },
    { op: "sample", value: 5, weight: 2 },
    { op: "missing" },
    { op: "sample", value: 6, weight: 1 },
    { op: "query" },
  ];
  const fork = original.branch();
  for (const event of forkEvents) applyEvent(fork, event);

  // The old view is untouched by branch corrections.
  assert.equal(avg(original), viewBefore.average);
  assert.deepEqual(original.windowIndices(), viewBefore.window);
  assert.deepEqual([0, 1, 3, 4].map((i) => original.effectiveWeightAt(i).toString()), viewBefore.weights);

  // The branch matches a full precise resample + reweight of the event log.
  const expected = runReference([...base, ...forkEvents], config);
  const want = expected[expected.length - 1] as Rational;
  assert.equal(avg(fork), want.toString());
});

test("fuzz: incremental series matches direct recomputation on random histories", () => {
  const config = { k: 4, period: 3 };
  const random = mulberry32(20261005);
  const events: ReferenceEvent[] = [];
  const series = new SignalSeries(config);
  const sampleIndices: number[] = [];
  let nextIndex = 0;

  for (let step = 0; step < 400; step++) {
    const roll = random();
    let event: ReferenceEvent;
    if (roll < 0.5) {
      event = {
        op: "sample",
        value: Math.floor(random() * 41) - 20,
        weight: Math.floor(random() * 6),
      };
      sampleIndices.push(nextIndex++);
    } else if (roll < 0.65) {
      event = { op: "missing" };
      nextIndex++;
    } else if (roll < 0.8 && sampleIndices.length > 0) {
      const pos = Math.floor(random() * sampleIndices.length);
      event = {
        op: "correct",
        index: sampleIndices[pos] as number,
        value: Math.floor(random() * 41) - 20,
        weight: Math.floor(random() * 6),
      };
    } else if (roll < 0.9 && sampleIndices.length > 0) {
      const pos = Math.floor(random() * sampleIndices.length);
      event = { op: "delete", index: sampleIndices[pos] as number };
      sampleIndices.splice(pos, 1);
    } else {
      event = { op: "sample", value: Math.floor(random() * 41) - 20, weight: Math.floor(random() * 6) };
      sampleIndices.push(nextIndex++);
    }
    events.push(event);
    applyEvent(series, event);

    const wantAvg = directFromEvents(events, config);
    assert.equal(avg(series), wantAvg, `step ${step}: ${JSON.stringify(event)}`);
  }
});

function directFromEvents(events: readonly ReferenceEvent[], config: { k: number; period: number }): string | null {
  const out = runReference([...events, { op: "query" }], config);
  const last = out[out.length - 1] as Rational | null;
  return last === null ? null : last.toString();
}

function applyEvent(series: SignalSeries, event: ReferenceEvent): void {
  switch (event.op) {
    case "sample":
      series.appendSample(event.value, event.weight);
      break;
    case "missing":
      series.appendMissing();
      break;
    case "correct":
      series.correct(event.index, event.value, event.weight);
      break;
    case "delete":
      series.delete(event.index);
      break;
    case "query":
      break;
  }
}

function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
