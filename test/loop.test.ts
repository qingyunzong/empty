import { test } from "node:test";
import { ok } from "node:assert/strict";
import { Rational } from "../src/rational.js";
import { Timeline, keyframe } from "../src/timeline.js";
import { sampleLooped } from "../src/loop.js";

const r = (n: number | bigint, d: number | bigint = 1) => Rational.of(n, d);

// Ramp 0 -> 2 over integer times [0, 4]; slope 1/2 per tick.
const ramp = new Timeline([keyframe(0, r(0)), keyframe(4, r(2))]);

test("repeat: interval end maps back to the start value", () => {
  ok(sampleLooped(ramp, 4n, "repeat").equals(r(0)));
  ok(sampleLooped(ramp, 8n, "repeat").equals(r(0)));
  ok(sampleLooped(ramp, 5n, "repeat").equals(r(1, 2)));
  ok(sampleLooped(ramp, 7n, "repeat").equals(r(3, 2)));
});

test("repeat: exact rational reference across the loop turn", () => {
  const expected = [r(3, 2), r(0), r(1, 2), r(1), r(3, 2), r(0)];
  for (let i = 0; i < expected.length; i++) {
    const t = BigInt(3 + i);
    ok(sampleLooped(ramp, t, "repeat").equals(expected[i]!), `t=${t}`);
  }
});

test("repeat: negative times wrap into the loop interval", () => {
  ok(sampleLooped(ramp, -1n, "repeat").equals(r(3, 2)));
  ok(sampleLooped(ramp, -4n, "repeat").equals(r(0)));
});

test("reverse: turning points hit endpoints exactly, then come back", () => {
  const expected = new Map<bigint, Rational>([
    [3n, r(3, 2)],
    [4n, r(2)],
    [5n, r(3, 2)],
    [6n, r(1)],
    [7n, r(1, 2)],
    [8n, r(0)],
    [9n, r(1, 2)],
    [12n, r(2)],
    [16n, r(0)],
  ]);
  for (const [t, want] of expected) {
    ok(sampleLooped(ramp, t, "reverse").equals(want), `t=${t}`);
  }
});

test("reverse: period is twice the duration", () => {
  for (let t = 0n; t < 8n; t++) {
    ok(sampleLooped(ramp, t, "reverse").equals(sampleLooped(ramp, t + 8n, "reverse")));
  }
});

test("none: no looping, endpoints clamp", () => {
  ok(sampleLooped(ramp, 99n, "none").equals(r(2)));
  ok(sampleLooped(ramp, -3n, "none").equals(r(0)));
});

test("single-instant timeline loops trivially", () => {
  const dot = new Timeline([keyframe(3, r(5))]);
  ok(sampleLooped(dot, 0n, "repeat").equals(r(5)));
  ok(sampleLooped(dot, 42n, "reverse").equals(r(5)));
});

test("non-zero loop origin is respected", () => {
  const shifted = new Timeline([keyframe(10, r(1)), keyframe(14, r(3))]);
  ok(sampleLooped(shifted, 14n, "repeat").equals(r(1)));
  ok(sampleLooped(shifted, 15n, "repeat").equals(r(3, 2)));
  ok(sampleLooped(shifted, 14n, "reverse").equals(r(3)));
  ok(sampleLooped(shifted, 18n, "reverse").equals(r(1)));
});
