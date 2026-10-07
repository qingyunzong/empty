import { test } from "node:test";
import assert from "node:assert/strict";
import { runSimulation, SimConfig } from "../src/simulator";
import { replayReference } from "../src/reference";
import { mulberry32 } from "../src/rng";

const scenarios: SimConfig[] = [
  { probeInterval: 4, suspectTimeout: 6, suspicionTimeout: 8, maxDelay: 10, dropRate: 0.3, ticks: 200 },
  { probeInterval: 3, suspectTimeout: 4, suspicionTimeout: 4, maxDelay: 12, dropRate: 0.5, ticks: 150 },
  { probeInterval: 5, suspectTimeout: 5, suspicionTimeout: 10, maxDelay: 2, dropRate: 0.1, ticks: 120 },
  { probeInterval: 2, suspectTimeout: 3, suspicionTimeout: 3, maxDelay: 6, dropRate: 0.7, ticks: 100 },
];

test("single-node simulator matches the reference model across seeds and configs", () => {
  for (const cfg of scenarios) {
    for (let seed = 1; seed <= 50; seed++) {
      const { timeline, events } = runSimulation(cfg, mulberry32(seed));
      const expected = replayReference(cfg, events);
      assert.deepEqual(timeline, expected, `mismatch for seed ${seed}`);
    }
  }
});
