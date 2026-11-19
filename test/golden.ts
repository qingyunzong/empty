import { test } from "node:test";
import assert from "node:assert/strict";
import { decide } from "../index.js";
import type { DecisionInput } from "../src/types.js";
import { referenceDecide } from "./oracle.js";

// Every expectation below is hand-computed from the written specification.
// These constants are authored directly and never produced by decide().

test("golden: max over container proposals drives an immediate scale-up", () => {
  const input: DecisionInput = {
    now: 1000,
    currentReplicas: 10,
    containers: [
      { name: "cpu", targetUtilization: 50, currentUtilization: 75 },
      { name: "mem", targetUtilization: 80, currentUtilization: 40 },
    ],
    stabilizationWindowMs: 600,
    history: [],
    policy: { minReplicas: 1, maxScaleUpRatio: 1, maxScaleDownRatio: 1 },
  };
  // cpu: ceil(10*75/50) = 15 ; mem: ceil(10*40/80) = 5 -> candidate 15 (cpu)
  const result = decide(input);
  assert.equal(result.candidateReplicas, 15);
  assert.equal(result.candidateContainer, "cpu");
  assert.equal(result.desiredReplicas, 15);
  assert.equal(result.action, "scale-up");
  assert.equal(result.basis, "container");
  assert.deepEqual(result.windowConsidered, []);
  assert.equal(result.windowPeak, null);
  assert.equal(result.windowPeakAt, null);
  assert.deepEqual(result.containerTraces.map((trace) => trace.recommended), [15, 5]);
});

test("golden: scale-down only takes effect past the stabilization window peak", () => {
  const input: DecisionInput = {
    now: 1000,
    currentReplicas: 10,
    containers: [
      { name: "cpu", targetUtilization: 80, currentUtilization: 40 },
    ],
    stabilizationWindowMs: 300,
    history: [
      { at: 699, replicas: 20 }, // just outside the [700,1000] window
      { at: 700, replicas: 8 }, // exactly on the inclusive lower boundary
      { at: 1000, replicas: 7 }, // exactly on the inclusive upper boundary
      { at: 1001, replicas: 30 }, // future sample must be ignored
    ],
    policy: { minReplicas: 1, maxScaleUpRatio: 1, maxScaleDownRatio: 1 },
  };
  // candidate: ceil(10*40/80) = 5 ; in-window peak = 8 -> stabilized 8
  const result = decide(input);
  assert.equal(result.candidateReplicas, 5);
  assert.deepEqual(
    result.windowConsidered.map((sample) => sample.at),
    [700, 1000],
  );
  assert.equal(result.windowPeak, 8);
  assert.equal(result.windowPeakAt, 700);
  assert.equal(result.stabilizedReplicas, 8);
  assert.equal(result.desiredReplicas, 8);
  assert.equal(result.action, "scale-down");
  assert.equal(result.basis, "window");
});

test("golden: max scale-up ratio truncates toward current replicas", () => {
  const input: DecisionInput = {
    now: 0,
    currentReplicas: 10,
    containers: [{ name: "cpu", targetUtilization: 10, currentUtilization: 100 }],
    stabilizationWindowMs: 0,
    history: [],
    policy: { minReplicas: 1, maxScaleUpRatio: 0.25, maxScaleDownRatio: 1 },
  };
  // candidate = ceil(10*100/10) = 100 ; up bound = ceil(10*1.25) = 13
  const result = decide(input);
  assert.equal(result.candidateReplicas, 100);
  assert.equal(result.clampedReplicas, 13);
  assert.equal(result.desiredReplicas, 13);
  assert.equal(result.action, "scale-up");
  assert.equal(result.basis, "container");
});

test("golden: max scale-down ratio floors the contraction", () => {
  const input: DecisionInput = {
    now: 500,
    currentReplicas: 10,
    containers: [{ name: "cpu", targetUtilization: 100, currentUtilization: 10 }],
    stabilizationWindowMs: 1000,
    history: [{ at: 500, replicas: 3 }],
    policy: { minReplicas: 1, maxScaleUpRatio: 1, maxScaleDownRatio: 0.2 },
  };
  // candidate = ceil(10*10/100) = 1 ; window peak 3 -> stabilized 3
  // down bound = floor(10*0.8) = 8 -> clamp to 8
  const result = decide(input);
  assert.equal(result.stabilizedReplicas, 3);
  assert.equal(result.clampedReplicas, 8);
  assert.equal(result.desiredReplicas, 8);
  assert.equal(result.action, "scale-down");
  assert.equal(result.basis, "window");
});

test("golden: min replicas clamps and records the min basis", () => {
  const input: DecisionInput = {
    now: 500,
    currentReplicas: 10,
    containers: [{ name: "cpu", targetUtilization: 100, currentUtilization: 10 }],
    stabilizationWindowMs: 1000,
    history: [{ at: 200, replicas: 2 }],
    policy: { minReplicas: 6, maxScaleUpRatio: 1, maxScaleDownRatio: 1 },
  };
  // candidate 1, window peak 2 -> stabilized/clamped 2, then min 6 wins
  const result = decide(input);
  assert.equal(result.clampedReplicas, 2);
  assert.equal(result.desiredReplicas, 6);
  assert.equal(result.action, "scale-down");
  assert.equal(result.basis, "min");
});

test("golden: equal desired value is a no-op and never flaps", () => {
  const input: DecisionInput = {
    now: 0,
    currentReplicas: 10,
    containers: [{ name: "cpu", targetUtilization: 50, currentUtilization: 50 }],
    stabilizationWindowMs: 0,
    history: [],
    policy: { minReplicas: 1, maxScaleUpRatio: 0.5, maxScaleDownRatio: 0.5 },
  };
  // candidate = ceil(10*50/50) = 10 -> unchanged
  const result = decide(input);
  assert.equal(result.desiredReplicas, 10);
  assert.equal(result.action, "none");
  assert.equal(result.basis, "current");
  const second = decide(input);
  assert.deepEqual(second, result);
});

test("golden: container tie resolves to the first declaring container", () => {
  const input: DecisionInput = {
    now: 0,
    currentReplicas: 4,
    containers: [
      { name: "first", targetUtilization: 50, currentUtilization: 100 },
      { name: "second", targetUtilization: 50, currentUtilization: 100 },
    ],
    stabilizationWindowMs: 0,
    history: [],
    policy: { minReplicas: 1, maxScaleUpRatio: 1, maxScaleDownRatio: 1 },
  };
  const result = decide(input);
  assert.equal(result.candidateReplicas, 8);
  assert.equal(result.candidateContainer, "first");
  assert.equal(result.desiredReplicas, 8);
});

test("golden: zero-width window includes only the current tick", () => {
  const input: DecisionInput = {
    now: 300,
    currentReplicas: 10,
    containers: [{ name: "cpu", targetUtilization: 100, currentUtilization: 20 }],
    stabilizationWindowMs: 0,
    history: [
      { at: 299, replicas: 9 },
      { at: 300, replicas: 6 },
    ],
    policy: { minReplicas: 1, maxScaleUpRatio: 1, maxScaleDownRatio: 1 },
  };
  const result = decide(input);
  assert.deepEqual(result.windowConsidered.map((sample) => sample.at), [300]);
  assert.equal(result.windowPeak, 6);
  assert.equal(result.desiredReplicas, 6);
});

test("golden: every hand-authored case agrees with the independent oracle", () => {
  const cases: DecisionInput[] = [
    {
      now: 1000,
      currentReplicas: 10,
      containers: [
        { name: "cpu", targetUtilization: 50, currentUtilization: 75 },
        { name: "mem", targetUtilization: 80, currentUtilization: 40 },
      ],
      stabilizationWindowMs: 600,
      history: [],
      policy: { minReplicas: 1, maxScaleUpRatio: 1, maxScaleDownRatio: 1 },
    },
    {
      now: 1000,
      currentReplicas: 10,
      containers: [{ name: "cpu", targetUtilization: 80, currentUtilization: 40 }],
      stabilizationWindowMs: 300,
      history: [
        { at: 699, replicas: 20 },
        { at: 700, replicas: 8 },
        { at: 1000, replicas: 7 },
        { at: 1001, replicas: 30 },
      ],
      policy: { minReplicas: 1, maxScaleUpRatio: 1, maxScaleDownRatio: 1 },
    },
    {
      now: 0,
      currentReplicas: 10,
      containers: [{ name: "cpu", targetUtilization: 10, currentUtilization: 100 }],
      stabilizationWindowMs: 0,
      history: [],
      policy: { minReplicas: 1, maxScaleUpRatio: 0.25, maxScaleDownRatio: 1 },
    },
    {
      now: 500,
      currentReplicas: 10,
      containers: [{ name: "cpu", targetUtilization: 100, currentUtilization: 10 }],
      stabilizationWindowMs: 1000,
      history: [{ at: 500, replicas: 3 }],
      policy: { minReplicas: 1, maxScaleUpRatio: 1, maxScaleDownRatio: 0.2 },
    },
    {
      now: 500,
      currentReplicas: 10,
      containers: [{ name: "cpu", targetUtilization: 100, currentUtilization: 10 }],
      stabilizationWindowMs: 1000,
      history: [{ at: 200, replicas: 2 }],
      policy: { minReplicas: 6, maxScaleUpRatio: 1, maxScaleDownRatio: 1 },
    },
    {
      now: 0,
      currentReplicas: 10,
      containers: [{ name: "cpu", targetUtilization: 50, currentUtilization: 50 }],
      stabilizationWindowMs: 0,
      history: [],
      policy: { minReplicas: 1, maxScaleUpRatio: 0.5, maxScaleDownRatio: 0.5 },
    },
    {
      now: 0,
      currentReplicas: 4,
      containers: [
        { name: "first", targetUtilization: 50, currentUtilization: 100 },
        { name: "second", targetUtilization: 50, currentUtilization: 50 },
      ],
      stabilizationWindowMs: 0,
      history: [],
      policy: { minReplicas: 1, maxScaleUpRatio: 1, maxScaleDownRatio: 1 },
    },
    {
      now: 300,
      currentReplicas: 10,
      containers: [{ name: "cpu", targetUtilization: 100, currentUtilization: 20 }],
      stabilizationWindowMs: 0,
      history: [
        { at: 299, replicas: 9 },
        { at: 300, replicas: 6 },
      ],
      policy: { minReplicas: 1, maxScaleUpRatio: 1, maxScaleDownRatio: 1 },
    },
  ];
  for (const input of cases) {
    assert.deepEqual(decide(input), referenceDecide(input));
  }
});

test("golden: invalid inputs are rejected by both implementations", () => {
  const base: DecisionInput = {
    now: 0,
    currentReplicas: 10,
    containers: [{ name: "cpu", targetUtilization: 50, currentUtilization: 50 }],
    stabilizationWindowMs: 0,
    history: [],
    policy: { minReplicas: 1, maxScaleUpRatio: 1, maxScaleDownRatio: 1 },
  };
  const invalid: DecisionInput[] = [
    { ...base, currentReplicas: 0 },
    { ...base, containers: [] },
    { ...base, containers: [{ name: "cpu", targetUtilization: 0, currentUtilization: 50 }] },
    { ...base, containers: [{ name: "cpu", targetUtilization: 50, currentUtilization: -1 }] },
    { ...base, policy: { ...base.policy, minReplicas: 0 } },
    { ...base, policy: { ...base.policy, maxScaleDownRatio: 1.5 } },
  ];
  for (const input of invalid) {
    assert.throws(() => decide(input));
    assert.throws(() => referenceDecide(input));
  }
});
