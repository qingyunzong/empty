import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  AlertEngine,
  computeIntervalsBySegments,
  computeIntervalsTickByTick,
  intervalKey,
} from "../src/index";
import type { AlertInterval, EngineOutput, Sample } from "../src/index";

function feed(
  engine: AlertEngine,
  events: Array<{ tick: number; value: number }>,
): EngineOutput[] {
  const outputs: EngineOutput[] = [];
  for (const event of events) outputs.push(...engine.ingest(event));
  return outputs;
}

function alertsOf(outputs: EngineOutput[]): AlertInterval[] {
  return outputs.filter((o) => o.type === "alert").map((o) => o.interval);
}

function retractsOf(outputs: EngineOutput[]): AlertInterval[] {
  return outputs.filter((o) => o.type === "retract").map((o) => o.interval);
}

function netAlerts(outputs: EngineOutput[]): Map<string, AlertInterval> {
  const net = new Map<string, AlertInterval>();
  for (const output of outputs) {
    const key = intervalKey(output.interval);
    if (output.type === "alert") net.set(key, output.interval);
    else net.delete(key);
  }
  return net;
}

describe("hold-sequence alert semantics", () => {
  it("emits one interval with start/end evidence when value > threshold for >= d ticks", () => {
    const engine = new AlertEngine(10, 3);
    const outputs = feed(engine, [
      { tick: 1, value: 5 },
      { tick: 2, value: 11 },
      { tick: 3, value: 12 },
      { tick: 4, value: 13 },
      { tick: 5, value: 7 },
    ]);
    const alerts = alertsOf(outputs);
    assert.equal(alerts.length, 1);
    assert.equal(alerts[0]!.start, 2);
    assert.equal(alerts[0]!.end, 4);
    assert.deepEqual(alerts[0]!.startEvidence, { tick: 2, value: 11 });
    assert.deepEqual(alerts[0]!.endEvidence, { tick: 4, value: 13 });
    assert.equal(retractsOf(outputs).length, 0);
  });

  it("a missing tick breaks the run, so two short runs raise no alert", () => {
    const engine = new AlertEngine(10, 3);
    const outputs = feed(engine, [
      { tick: 1, value: 11 },
      { tick: 2, value: 12 },
      // tick 3 missing
      { tick: 4, value: 13 },
      { tick: 5, value: 14 },
    ]);
    assert.equal(alertsOf(outputs).length, 0);
    assert.equal(engine.activeAlerts().length, 0);
  });

  it("applies a same-tick correction before evaluation", () => {
    const engine = new AlertEngine(10, 2);
    const outputs = feed(engine, [
      { tick: 1, value: 11 },
      { tick: 2, value: 12 },
      { tick: 2, value: 3 }, // correction: tick 2 drops below threshold
    ]);
    assert.equal(netAlerts(outputs).size, 0);
    assert.equal(engine.activeAlerts().length, 0);
  });

  it("a late below-threshold event retracts a previously emitted alert", () => {
    const engine = new AlertEngine(10, 3);
    const first = feed(engine, [
      { tick: 1, value: 11 },
      { tick: 2, value: 12 },
      { tick: 3, value: 13 },
    ]);
    assert.equal(alertsOf(first).length, 1);

    // Late correction lands inside the interval and breaks the run.
    const second = engine.ingest({ tick: 2, value: 4 });
    const retracts = retractsOf(second);
    assert.equal(retracts.length, 1);
    assert.equal(retracts[0]!.start, 1);
    assert.equal(retracts[0]!.end, 3);
    assert.equal(engine.activeAlerts().length, 0);
  });

  it("a late event filling a gap can create an alert retroactively", () => {
    const engine = new AlertEngine(10, 3);
    feed(engine, [
      { tick: 1, value: 11 },
      // tick 2 missing
      { tick: 3, value: 13 },
    ]);
    const outputs = engine.ingest({ tick: 2, value: 12 });
    const alerts = alertsOf(outputs);
    assert.equal(alerts.length, 1);
    assert.equal(alerts[0]!.start, 1);
    assert.equal(alerts[0]!.end, 3);
    assert.deepEqual(alerts[0]!.startEvidence, { tick: 1, value: 11 });
    assert.deepEqual(alerts[0]!.endEvidence, { tick: 3, value: 13 });
  });

  it("extending a run replaces the old interval (retract + alert)", () => {
    const engine = new AlertEngine(10, 2);
    feed(engine, [
      { tick: 1, value: 11 },
      { tick: 2, value: 12 },
    ]);
    const outputs = engine.ingest({ tick: 3, value: 13 });
    assert.equal(retractsOf(outputs).length, 1);
    const alerts = alertsOf(outputs);
    assert.equal(alerts.length, 1);
    assert.equal(alerts[0]!.end, 3);
  });
});

describe("engine vs tick-by-tick reference model", () => {
  it("agrees on a hand-built sequence with gaps and corrections", () => {
    const engine = new AlertEngine(10, 3);
    const outputs = feed(engine, [
      { tick: 1, value: 11 },
      { tick: 2, value: 12 },
      { tick: 3, value: 13 },
      { tick: 5, value: 14 }, // gap at 4
      { tick: 6, value: 15 },
      { tick: 7, value: 16 },
      { tick: 8, value: 2 },
      { tick: 9, value: 17 },
      { tick: 2, value: 1 }, // late correction breaks first run
    ]);
    const materialized: Sample[] = [
      { tick: 1, value: 11 },
      { tick: 2, value: 1 },
      { tick: 3, value: 13 },
      { tick: 5, value: 14 },
      { tick: 6, value: 15 },
      { tick: 7, value: 16 },
      { tick: 8, value: 2 },
      { tick: 9, value: 17 },
    ];
    const expected = computeIntervalsTickByTick(materialized, 10, 3);
    const net = netAlerts(outputs);
    assert.deepEqual(
      [...net.keys()].sort(),
      expected.map(intervalKey).sort(),
    );
    assert.deepEqual(
      engine.activeAlerts().map(intervalKey).sort(),
      expected.map(intervalKey).sort(),
    );
  });

  it("matches the reference on randomized streams with late events and corrections", () => {
    // Deterministic PRNG (mulberry32) so failures are reproducible.
    let state = 0x9e3779b9;
    const rand = (): number => {
      state |= 0;
      state = (state + 0x6d2b79f5) | 0;
      let t = Math.imul(state ^ (state >>> 15), 1 | state);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };

    for (let trial = 0; trial < 500; trial++) {
      const threshold = 10;
      const minDuration = 1 + Math.floor(rand() * 4);
      const engine = new AlertEngine(threshold, minDuration);
      const outputs: EngineOutput[] = [];
      const finalValues = new Map<number, number>();

      const eventCount = 1 + Math.floor(rand() * 60);
      for (let i = 0; i < eventCount; i++) {
        const event = {
          tick: Math.floor(rand() * 25),
          value: Math.floor(rand() * 20),
        };
        outputs.push(...engine.ingest(event));
        finalValues.set(event.tick, event.value);
      }

      const materialized: Sample[] = [...finalValues.entries()].map(
        ([tick, value]) => ({ tick, value }),
      );
      const expected = computeIntervalsTickByTick(
        materialized,
        threshold,
        minDuration,
      );
      const viaSegments = computeIntervalsBySegments(
        finalValues,
        threshold,
        minDuration,
      );

      // Engine net state equals both models.
      assert.deepEqual(
        [...netAlerts(outputs).keys()].sort(),
        expected.map(intervalKey).sort(),
        `trial ${trial}: engine net alerts != tick-by-tick reference`,
      );
      assert.deepEqual(
        viaSegments.map(intervalKey).sort(),
        expected.map(intervalKey).sort(),
        `trial ${trial}: segment scan != tick-by-tick reference`,
      );
      // Evidence must match the materialized data at both ends.
      for (const interval of expected) {
        assert.equal(
          finalValues.get(interval.start),
          interval.startEvidence.value,
        );
        assert.equal(finalValues.get(interval.end), interval.endEvidence.value);
        assert.ok(interval.end - interval.start + 1 >= minDuration);
      }
      // Retractions only ever name previously alerted intervals.
      const seen = new Set<string>();
      for (const output of outputs) {
        const key = intervalKey(output.interval);
        if (output.type === "alert") seen.add(key);
        else assert.ok(seen.has(key), `trial ${trial}: retract without alert`);
      }
    }
  });
});
