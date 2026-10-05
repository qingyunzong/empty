import { test } from "node:test";
import * as assert from "node:assert/strict";
import { StateSequence, type Sample, type Segment, type Value } from "../src/state-sequence.js";
import { interpretTick, interpretRange } from "../src/interpreter.js";

test("a sample holds until the next sample", () => {
  const seq = new StateSequence();
  seq.insert({ time: 0, value: "a", version: 1 });
  seq.insert({ time: 10, value: "b", version: 1 });
  assert.equal(seq.valueAt(0), "a");
  assert.equal(seq.valueAt(9), "a");
  assert.equal(seq.valueAt(10), "b");
  assert.equal(seq.valueAt(1000), "b");
  assert.deepEqual(seq.query(0, 15), [
    { start: 0, end: 10, value: "a" },
    { start: 10, end: 15, value: "b" },
  ]);
});

test("a sample expires at its own TTL, leaving a hole", () => {
  const seq = new StateSequence();
  seq.insert({ time: 0, value: "a", version: 1, ttl: 4 });
  seq.insert({ time: 10, value: "b", version: 1 });
  assert.equal(seq.valueAt(3), "a");
  assert.equal(seq.valueAt(4), null);
  assert.equal(seq.valueAt(9), null);
  assert.equal(seq.valueAt(10), "b");
  assert.deepEqual(seq.query(0, 12), [
    { start: 0, end: 4, value: "a" },
    { start: 4, end: 10, value: null },
    { start: 10, end: 12, value: "b" },
  ]);
});

test("an expired hole is not extended by deleting the successor", () => {
  const seq = new StateSequence();
  seq.insert({ time: 0, value: "a", version: 1, ttl: 4 });
  seq.insert({ time: 10, value: "b", version: 1 });
  assert.equal(seq.delete(10), true);
  // "a" expired at tick 4 and stays expired; the hole runs to infinity.
  assert.equal(seq.valueAt(3), "a");
  assert.equal(seq.valueAt(4), null);
  assert.equal(seq.valueAt(10), null);
  assert.equal(seq.valueAt(9999), null);
  assert.deepEqual(seq.query(0, 12), [
    { start: 0, end: 4, value: "a" },
    { start: 4, end: 12, value: null },
  ]);
});

test("corrections at the same time: the higher version wins", () => {
  const seq = new StateSequence();
  assert.equal(seq.insert({ time: 5, value: "x", version: 1 }), true);
  assert.equal(seq.insert({ time: 5, value: "y", version: 2 }), true);
  assert.equal(seq.insert({ time: 5, value: "z", version: 1 }), false);
  assert.equal(seq.insert({ time: 5, value: "w", version: 2 }), false);
  assert.equal(seq.valueAt(5), "y");
  assert.equal(seq.size, 1);
});

test("query merges adjacent equal values into maximal segments", () => {
  const seq = new StateSequence();
  seq.insert({ time: 0, value: "a", version: 1 });
  seq.insert({ time: 5, value: "a", version: 1 });
  seq.insert({ time: 10, value: "b", version: 1 });
  seq.insert({ time: 15, value: "b", version: 1 });
  assert.deepEqual(seq.query(0, 20), [
    { start: 0, end: 10, value: "a" },
    { start: 10, end: 20, value: "b" },
  ]);
});

test("query clips to the half-open range [start, end)", () => {
  const seq = new StateSequence();
  seq.insert({ time: 0, value: "a", version: 1, ttl: 10 });
  assert.deepEqual(seq.query(3, 8), [{ start: 3, end: 8, value: "a" }]);
  assert.deepEqual(seq.query(8, 20), [
    { start: 8, end: 10, value: "a" },
    { start: 10, end: 20, value: null },
  ]);
  assert.throws(() => seq.query(5, 5));
  assert.throws(() => seq.query(9, 5));
});

test("delete removes samples, optionally guarded by version", () => {
  const seq = new StateSequence();
  seq.insert({ time: 2, value: "a", version: 3 });
  assert.equal(seq.delete(7), false);
  assert.equal(seq.delete(2, 1), false);
  assert.equal(seq.delete(2, 3), true);
  assert.equal(seq.valueAt(2), null);
  assert.equal(seq.delete(2), false);
});

test("interpreter sanity: per-tick values over a hand-built sample list", () => {
  const samples: Sample[] = [
    { time: 4, value: "late", version: 1 },
    { time: 0, value: "v1", version: 1, ttl: 3 },
    { time: 0, value: "v2", version: 2, ttl: 3 },
  ];
  assert.deepEqual(interpretRange(samples, 0, 8), [
    "v2", "v2", "v2", null, "late", "late", "late", "late",
  ]);
});

// Deterministic PRNG (mulberry32) so the cross-check is reproducible.
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function checkAgainstInterpreter(
  seq: StateSequence,
  raw: Sample[],
  start: number,
  end: number,
): void {
  // 1. valueAt must match the per-tick interpreter at every tick.
  for (let t = start; t < end; t++) {
    assert.equal(
      seq.valueAt(t),
      interpretTick(raw, t),
      `valueAt mismatch at tick ${t}`,
    );
  }
  // 2. query must return contiguous half-open segments covering [start, end),
  //    each constant per the interpreter, and maximal (neighbours differ).
  const segments = seq.query(start, end);
  assert.ok(segments.length > 0);
  assert.equal(segments[0]!.start, start);
  assert.equal(segments[segments.length - 1]!.end, end);
  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i]!;
    assert.ok(seg.start < seg.end, `empty segment ${JSON.stringify(seg)}`);
    if (i > 0) {
      assert.equal(segments[i - 1]!.end, seg.start, "segments must be contiguous");
      assert.notEqual(
        segments[i - 1]!.value,
        seg.value,
        "adjacent segments must differ (maximality)",
      );
    }
    for (let t = seg.start; t < seg.end; t++) {
      assert.equal(
        interpretTick(raw, t),
        seg.value,
        `segment [${seg.start}, ${seg.end}) wrong at tick ${t}`,
      );
    }
  }
}

test("randomized inserts and deletes cross-checked against the per-tick interpreter", () => {
  const rand = mulberry32(20261005);
  const horizon = 60;
  const values: Value[] = ["a", "b", "c"];
  for (let round = 0; round < 40; round++) {
    const seq = new StateSequence();
    const raw: Sample[] = [];
    const ops = 20 + Math.floor(rand() * 30);
    for (let op = 0; op < ops; op++) {
      if (rand() < 0.7) {
        const sample: Sample = {
          time: Math.floor(rand() * horizon),
          value: values[Math.floor(rand() * values.length)]!,
          version: 1 + Math.floor(rand() * 3),
        };
        if (rand() < 0.5) sample.ttl = 1 + Math.floor(rand() * 8);
        if (seq.insert(sample)) raw.push(sample);
      } else {
        const time = Math.floor(rand() * horizon);
        if (seq.delete(time)) {
          for (let i = raw.length - 1; i >= 0; i--) {
            if (raw[i]!.time === time) raw.splice(i, 1);
          }
        }
      }
    }
    const start = Math.floor(rand() * 10);
    const end = horizon - Math.floor(rand() * 10);
    checkAgainstInterpreter(seq, raw, start, end);
  }
});

test("segment boundaries stay half-open under dense same-tick corrections", () => {
  const rand = mulberry32(7);
  const seq = new StateSequence();
  const raw: Sample[] = [];
  for (let i = 0; i < 200; i++) {
    const sample: Sample = {
      time: Math.floor(rand() * 20),
      value: rand() < 0.5 ? 0 : 1,
      version: Math.floor(rand() * 100),
    };
    if (rand() < 0.3) sample.ttl = 1 + Math.floor(rand() * 4);
    if (seq.insert(sample)) raw.push(sample);
  }
  checkAgainstInterpreter(seq, raw, 0, 25);
});
