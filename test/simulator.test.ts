import { test } from "node:test";
import assert from "node:assert/strict";
import { runSimulation, SimConfig } from "../src/simulator";
import { mulberry32 } from "../src/rng";

const base: SimConfig = {
  probeInterval: 4,
  suspectTimeout: 6,
  suspicionTimeout: 8,
  maxDelay: 10,
  dropRate: 0.3,
  ticks: 200,
};

const rank = { ALIVE: 0, SUSPECT: 1, DEAD: 2 } as const;

test("random delay reordering preserves invariants across seeds", () => {
  const signatures = new Set<string>();
  for (let seed = 1; seed <= 50; seed++) {
    const { detector, timeline } = runSimulation(base, mulberry32(seed));

    for (let i = 1; i < timeline.length; i++) {
      assert.ok(timeline[i].heartbeat >= timeline[i - 1].heartbeat, "heartbeat monotonic");
      const prev = rank[timeline[i - 1].status];
      const curr = rank[timeline[i].status];
      assert.ok(curr === prev || curr === prev + 1 || curr === 0, "only ALIVE->SUSPECT->DEAD or revival to ALIVE");
      assert.ok(!(prev === 2 && curr !== 2), "DEAD is terminal");
    }
    for (const tr of detector.transitions) {
      assert.ok(tr.reason.length > 0, "transition has rationale");
    }
    signatures.add(timeline.map((r) => r.status[0]).join(""));
  }
  assert.ok(signatures.size > 1, "random reordering produces distinct outcomes");
});

test("simulation is deterministic for a fixed seed", () => {
  const a = runSimulation(base, mulberry32(42)).timeline;
  const b = runSimulation(base, mulberry32(42)).timeline;
  assert.deepEqual(a, b);
});

test("no drops and short delays keep the node alive", () => {
  const { timeline, detector } = runSimulation(
    { ...base, dropRate: 0, maxDelay: 1 },
    mulberry32(7),
  );
  assert.ok(timeline.every((r) => r.status === "ALIVE"));
  assert.equal(detector.transitions.length, 0);
});

test("total packet loss drives the node to DEAD via SUSPECT", () => {
  const { timeline, detector } = runSimulation(
    { ...base, dropRate: 1 },
    mulberry32(7),
  );
  assert.equal(timeline[timeline.length - 1].status, "DEAD");
  const kinds = detector.transitions.map((t) => t.to);
  assert.ok(kinds.indexOf("SUSPECT") < kinds.indexOf("DEAD"));
  assert.equal(detector.heartbeat, 0);
});
