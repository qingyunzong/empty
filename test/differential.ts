import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { decide } from "../index.js";
import type { Decision, DecisionInput } from "../src/types.js";
import { referenceDecide } from "./oracle.js";

// Every expectation in this suite is produced by referenceDecide (the
// independent oracle). decide() only supplies the value under comparison.

function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let mixed = state;
    mixed = Math.imul(mixed ^ (mixed >>> 15), mixed | 1);
    mixed ^= mixed + Math.imul(mixed ^ (mixed >>> 7), mixed | 61);
    return ((mixed ^ (mixed >>> 14)) >>> 0) / 4294967296;
  };
}

function pickInteger(rand: () => number, min: number, max: number): number {
  return min + Math.floor(rand() * (max - min + 1));
}

function pickRatio(rand: () => number, choices: number[]): number {
  return choices[Math.floor(rand() * choices.length)] ?? 0;
}

function compare(input: DecisionInput): void {
  const actual = decide(input);
  const expected = referenceDecide(input);
  assert.deepEqual(actual, expected, `differential mismatch for ${JSON.stringify(input)}`);
}

function assertIsMaxOfContainers(decision: Decision): void {
  const maxRecommended = decision.containerTraces.reduce(
    (highest, trace) => Math.max(highest, trace.recommended),
    0,
  );
  assert.equal(decision.candidateReplicas, maxRecommended);
  const winner = decision.containerTraces.find(
    (trace) => trace.recommended === decision.candidateReplicas,
  );
  assert.ok(winner);
  assert.equal(winner?.name, decision.candidateContainer);
}

test("family A: exhaustive multi-container recommendation crossings", () => {
  let count = 0;
  const targets = [20, 40, 50, 80];
  const currents = [10, 25, 50, 75, 100, 120];
  const currentReplicasValues = [1, 3, 7, 10];
  for (const currentReplicas of currentReplicasValues) {
    for (const targetA of targets) {
      for (const currentA of currents) {
        for (const targetB of targets) {
          for (const currentB of currents) {
            const input: DecisionInput = {
              now: 1000,
              currentReplicas,
              containers: [
                { name: "alpha", targetUtilization: targetA, currentUtilization: currentA },
                { name: "beta", targetUtilization: targetB, currentUtilization: currentB },
              ],
              stabilizationWindowMs: 0,
              history: [],
              policy: { minReplicas: 1, maxScaleUpRatio: 1, maxScaleDownRatio: 1 },
            };
            const actual = decide(input);
            const expected = referenceDecide(input);
            assert.deepEqual(actual, expected);
            assertIsMaxOfContainers(actual);
            count += 1;
          }
        }
      }
    }
  }
  assert.ok(count > 1000, `expected a large enumeration, got ${count}`);
});

test("family A: three-container exhaustive crossing on a compact domain", () => {
  let count = 0;
  const values = [25, 50, 100];
  for (const targetA of values) {
    for (const currentA of values) {
      for (const targetB of values) {
        for (const currentB of values) {
          for (const targetC of values) {
            for (const currentC of values) {
              const input: DecisionInput = {
                now: 10,
                currentReplicas: 6,
                containers: [
                  { name: "a", targetUtilization: targetA, currentUtilization: currentA },
                  { name: "b", targetUtilization: targetB, currentUtilization: currentB },
                  { name: "c", targetUtilization: targetC, currentUtilization: currentC },
                ],
                stabilizationWindowMs: 0,
                history: [],
                policy: { minReplicas: 1, maxScaleUpRatio: 1, maxScaleDownRatio: 1 },
              };
              compare(input);
              assertIsMaxOfContainers(decide(input));
              count += 1;
            }
          }
        }
      }
    }
  }
  assert.equal(count, 729);
});

test("family B: window boundaries are inclusive on both edges and ordered", () => {
  let count = 0;
  const now = 1000;
  const windowMs = 300;
  const sampleTimes = [699, 700, 850, 1000, 1001];
  const peakChoices = [2, 4, 7, 9, 12];
  for (const peak of peakChoices) {
    for (const boundaryA of sampleTimes) {
      for (const boundaryB of sampleTimes) {
        const input: DecisionInput = {
          now,
          currentReplicas: 10,
          containers: [{ name: "cpu", targetUtilization: 100, currentUtilization: 50 }],
          stabilizationWindowMs: windowMs,
          history: [
            { at: boundaryA, replicas: peak },
            { at: boundaryB, replicas: 3 },
          ],
          policy: { minReplicas: 1, maxScaleUpRatio: 1, maxScaleDownRatio: 1 },
        };
        const actual = decide(input);
        const expected = referenceDecide(input);
        assert.deepEqual(actual, expected);

        const includedTimes = actual.windowConsidered.map((sample) => sample.at);
        for (const at of includedTimes) {
          assert.ok(at >= now - windowMs, "lower window boundary must be inclusive");
          assert.ok(at <= now, "upper window boundary must be inclusive");
        }
        const sortedTimes = [...includedTimes].sort((left, right) => left - right);
        assert.deepEqual(includedTimes, sortedTimes, "window samples must be time-ordered");

        if (includedTimes.length > 0) {
          const expectedPeak = Math.max(
            ...input.history
              .filter((sample) => sample.at >= now - windowMs && sample.at <= now)
              .map((sample) => sample.replicas),
          );
          assert.equal(actual.windowPeak, expectedPeak);
          if (actual.candidateReplicas < input.currentReplicas) {
            assert.equal(
              actual.stabilizedReplicas,
              Math.max(actual.candidateReplicas, expectedPeak),
            );
          }
        } else {
          assert.equal(actual.windowPeak, null);
          assert.equal(actual.windowPeakAt, null);
        }
        count += 1;
      }
    }
  }
  assert.ok(count > 100);
});

test("family B: zero-width and empty windows never delay scale decisions", () => {
  const now = 400;
  for (const windowMs of [0, 1, 50, 400]) {
    for (const sampleAt of [399, 400, 401]) {
      const input: DecisionInput = {
        now,
        currentReplicas: 10,
        containers: [{ name: "cpu", targetUtilization: 100, currentUtilization: 30 }],
        stabilizationWindowMs: windowMs,
        history: [{ at: sampleAt, replicas: 9 }],
        policy: { minReplicas: 1, maxScaleUpRatio: 1, maxScaleDownRatio: 1 },
      };
      compare(input);
      const decision = decide(input);
      if (windowMs === 0 && sampleAt !== now) {
        assert.deepEqual(decision.windowConsidered, []);
        assert.equal(decision.stabilizedReplicas, decision.candidateReplicas);
      }
    }
  }
});

test("family C: max per-cycle scale ratios truncate every direction", () => {
  let count = 0;
  const upRatios = [0, 0.1, 0.25, 0.5, 1];
  const downRatios = [0, 0.1, 0.25, 0.5, 1];
  const directions: Array<{ target: number; current: number }> = [
    { target: 10, current: 100 },
    { target: 20, current: 80 },
    { target: 100, current: 10 },
    { target: 80, current: 20 },
    { target: 50, current: 50 },
  ];
  for (const direction of directions) {
    for (const maxScaleUpRatio of upRatios) {
      for (const maxScaleDownRatio of downRatios) {
        const input: DecisionInput = {
          now: 100,
          currentReplicas: 10,
          containers: [
            {
              name: "cpu",
              targetUtilization: direction.target,
              currentUtilization: direction.current,
            },
          ],
          stabilizationWindowMs: 1000,
          history: [{ at: 100, replicas: direction.target === 50 ? 10 : 3 }],
          policy: { minReplicas: 1, maxScaleUpRatio, maxScaleDownRatio },
        };
        const actual = decide(input);
        const expected = referenceDecide(input);
        assert.deepEqual(actual, expected);

        if (actual.stabilizedReplicas > input.currentReplicas) {
          const allowedCeiling = Math.ceil(
            input.currentReplicas * (1 + maxScaleUpRatio),
          );
          assert.ok(actual.clampedReplicas <= allowedCeiling);
          assert.ok(actual.clampedReplicas >= input.currentReplicas);
          assert.equal(
            actual.clampedReplicas,
            Math.min(actual.stabilizedReplicas, allowedCeiling),
          );
        } else if (actual.stabilizedReplicas < input.currentReplicas) {
          const allowedFloor = Math.floor(
            input.currentReplicas * (1 - maxScaleDownRatio),
          );
          assert.ok(actual.clampedReplicas >= allowedFloor);
          assert.ok(actual.clampedReplicas <= input.currentReplicas);
          assert.equal(
            actual.clampedReplicas,
            Math.max(actual.stabilizedReplicas, allowedFloor),
          );
        } else {
          assert.equal(actual.clampedReplicas, input.currentReplicas);
        }
        count += 1;
      }
    }
  }
  assert.equal(count, 125);
});

test("family D: min replicas clamps all previously computed stages", () => {
  let count = 0;
  const minValues = [1, 2, 5, 8, 10, 15];
  const scenarios: Array<{ target: number; current: number; historyReplica: number }> = [
    { target: 100, current: 10, historyReplica: 2 },
    { target: 50, current: 10, historyReplica: 4 },
    { target: 10, current: 100, historyReplica: 12 },
    { target: 80, current: 20, historyReplica: 9 },
  ];
  for (const scenario of scenarios) {
    for (const minReplicas of minValues) {
      const input: DecisionInput = {
        now: 700,
        currentReplicas: 10,
        containers: [
          {
            name: "cpu",
            targetUtilization: scenario.target,
            currentUtilization: scenario.current,
          },
        ],
        stabilizationWindowMs: 1000,
        history: [{ at: 300, replicas: scenario.historyReplica }],
        policy: { minReplicas, maxScaleUpRatio: 0.5, maxScaleDownRatio: 0.5 },
      };
      const actual = decide(input);
      const expected = referenceDecide(input);
      assert.deepEqual(actual, expected);
      assert.ok(actual.desiredReplicas >= minReplicas);
      if (actual.clampedReplicas < minReplicas) {
        assert.equal(actual.desiredReplicas, minReplicas);
        if (minReplicas === input.currentReplicas) {
          assert.equal(actual.basis, "current");
        } else {
          assert.equal(actual.basis, "min");
        }
      } else {
        assert.equal(actual.desiredReplicas, actual.clampedReplicas);
      }
      count += 1;
    }
  }
  assert.equal(count, 24);
});

test("fuzz: 4000 randomized scenarios match the oracle end-to-end", () => {
  const rand = mulberry32(0x5eed1003);
  for (let iteration = 0; iteration < 4000; iteration += 1) {
    const currentReplicas = pickInteger(rand, 1, 24);
    const containerCount = pickInteger(rand, 1, 4);
    const containers = Array.from({ length: containerCount }, (_, index) => ({
      name: `c${index}`,
      targetUtilization: pickInteger(rand, 1, 120),
      currentUtilization: pickInteger(rand, 1, 160),
    }));
    const now = pickInteger(rand, 0, 5000);
    const stabilizationWindowMs = pickInteger(rand, 0, 2000);
    const historyLength = pickInteger(rand, 0, 6);
    const history = Array.from({ length: historyLength }, () => ({
      at: pickInteger(rand, 0, now + 500),
      replicas: pickInteger(rand, 1, currentReplicas + 12),
    }));
    const input: DecisionInput = {
      now,
      currentReplicas,
      containers,
      stabilizationWindowMs,
      history,
      policy: {
        minReplicas: pickInteger(rand, 1, 12),
        maxScaleUpRatio: pickRatio(rand, [0, 0.05, 0.1, 0.25, 0.5, 1, 2]),
        maxScaleDownRatio: pickRatio(rand, [0, 0.1, 0.2, 0.25, 0.5, 1]),
      },
    };
    compare(input);
    const decision = decide(input);
    assert.ok(decision.desiredReplicas >= input.policy.minReplicas);
    assert.ok(decision.desiredReplicas >= 1);
    assert.equal(
      decision.action === "none",
      decision.desiredReplicas === input.currentReplicas,
    );
  }
});

test("hygiene: the oracle never imports the library under test", () => {
  const oraclePath = fileURLToPath(new URL("./oracle.js", import.meta.url));
  const source = readFileSync(oraclePath, "utf8");
  assert.ok(!/from\s+["'][^"']*\.\.\/(index|src)\//.test(source), "oracle must not import src");
  assert.ok(!/\bdecide\s*\(/.test(source), "oracle must not call a decide() helper");
  assert.ok(!/arithmetic|types\.js|index\.js/.test(source), "oracle must not reuse library modules");
});
