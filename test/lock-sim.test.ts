import { test } from "node:test";
import assert from "node:assert/strict";
import { LockSimulator, type SimEvent } from "../src/lock-sim.js";

test("FIFO: requests are granted in order", () => {
  const sim = new LockSimulator();
  const steps = sim.run([
    { clock: 1, type: "request", pageId: "A", lock: "L", generation: 1 },
    { clock: 2, type: "request", pageId: "B", lock: "L", generation: 1 },
    { clock: 3, type: "request", pageId: "C", lock: "L", generation: 1 },
    { clock: 4, type: "release", pageId: "A", lock: "L", generation: 1 },
    { clock: 5, type: "release", pageId: "B", lock: "L", generation: 1 },
  ]);
  assert.equal(steps[0].owners["L"], "A#1");
  assert.equal(steps[1].owners["L"], "A#1");
  assert.deepEqual(steps[1].queues["L"], ["B#1"]);
  assert.equal(steps[3].owners["L"], "B#1"); // FIFO: B before C
  assert.equal(steps[4].owners["L"], "C#1");
  assert.ok(sim.verifyMutualExclusion());
});

test("out-of-order input is applied in logical-clock order", () => {
  const shuffled: SimEvent[] = [
    { clock: 4, type: "release", pageId: "A", lock: "L", generation: 1 },
    { clock: 1, type: "request", pageId: "A", lock: "L", generation: 1 },
    { clock: 3, type: "request", pageId: "C", lock: "L", generation: 1 },
    { clock: 2, type: "request", pageId: "B", lock: "L", generation: 1 },
  ];
  const sim = new LockSimulator();
  const steps = sim.run(shuffled);
  // Applied order must be clocks 1,2,3,4.
  assert.deepEqual(steps.map((s) => s.event.clock), [1, 2, 3, 4]);
  assert.equal(steps[3].owners["L"], "B#1"); // after A releases, B (not C) is next
  assert.ok(sim.verifyMutualExclusion());
});

test("crash releases held locks and drops waiting requests", () => {
  const sim = new LockSimulator();
  const steps = sim.run([
    { clock: 1, type: "request", pageId: "A", lock: "L1", generation: 1 },
    { clock: 2, type: "request", pageId: "A", lock: "L2", generation: 1 },
    { clock: 3, type: "request", pageId: "B", lock: "L1", generation: 1 },
    { clock: 4, type: "request", pageId: "A", lock: "L3", generation: 1 },
    { clock: 5, type: "request", pageId: "C", lock: "L3", generation: 1 },
    { clock: 6, type: "crash", pageId: "A" },
  ]);
  const last = steps[5];
  assert.equal(last.owners["L1"], "B#1"); // B was waiting, granted after crash
  assert.equal(last.owners["L2"], null); // held by A, now free
  assert.equal(last.owners["L3"], "C#1"); // A's wait dropped, C granted
  assert.deepEqual(last.queues["L3"], []);
  assert.ok(sim.verifyMutualExclusion());
});

test("recover creates a new generation; stale release is rejected", () => {
  const sim = new LockSimulator();
  const steps = sim.run([
    { clock: 1, type: "request", pageId: "A", lock: "L", generation: 1 },
    { clock: 2, type: "crash", pageId: "A" },
    { clock: 3, type: "recover", pageId: "A" },
    { clock: 4, type: "request", pageId: "B", lock: "L", generation: 1 },
    // Delayed release from A's old generation arrives late (out of order clock
    // is intentional: it was sent at clock 5 by the old, pre-crash A).
    { clock: 5, type: "release", pageId: "A", lock: "L", generation: 1 },
  ]);
  const stale = steps[4];
  assert.equal(stale.accepted, false);
  assert.match(stale.note, /stale release/);
  assert.equal(stale.owners["L"], "B#1"); // B keeps the lock
  // A's new generation can acquire again.
  const steps2 = sim.run([
    { clock: 6, type: "release", pageId: "B", lock: "L", generation: 1 },
    { clock: 7, type: "request", pageId: "A", lock: "L", generation: 2 },
  ]);
  assert.equal(steps2[6].owners["L"], "A#2");
  assert.ok(sim.verifyMutualExclusion());
});

test("stale request from an old generation is rejected", () => {
  const sim = new LockSimulator();
  const steps = sim.run([
    { clock: 1, type: "crash", pageId: "A" },
    { clock: 2, type: "recover", pageId: "A" },
    { clock: 3, type: "request", pageId: "A", lock: "L", generation: 1 },
  ]);
  assert.equal(steps[2].accepted, false);
  assert.equal(steps[2].owners["L"], null);
  assert.ok(sim.verifyMutualExclusion());
});

test("mutual exclusion holds across a mixed out-of-order scenario", () => {
  const events: SimEvent[] = [
    { clock: 9, type: "release", pageId: "B", lock: "L1", generation: 1 },
    { clock: 2, type: "request", pageId: "B", lock: "L1", generation: 1 },
    { clock: 7, type: "recover", pageId: "A" },
    { clock: 1, type: "request", pageId: "A", lock: "L1", generation: 1 },
    { clock: 8, type: "request", pageId: "A", lock: "L1", generation: 2 },
    { clock: 5, type: "release", pageId: "A", lock: "L1", generation: 1 },
    { clock: 6, type: "crash", pageId: "A" },
    { clock: 4, type: "request", pageId: "C", lock: "L1", generation: 1 },
    { clock: 3, type: "request", pageId: "A", lock: "L2", generation: 1 },
    { clock: 10, type: "release", pageId: "A", lock: "L1", generation: 1 }, // stale
  ];
  const sim = new LockSimulator();
  const steps = sim.run(events);
  assert.deepEqual(steps.map((s) => s.event.clock), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  // clock 5: A releases L1 -> B (clock 2) gets it before C (clock 4).
  assert.equal(steps[4].owners["L1"], "B#1");
  // clock 6: crash frees L2 (held by A); B unaffected.
  assert.equal(steps[5].owners["L2"], null);
  // clock 8: A#2 queues behind B and C.
  assert.deepEqual(steps[7].queues["L1"], ["C#1", "A#2"]);
  // clock 9: B releases -> C.
  assert.equal(steps[8].owners["L1"], "C#1");
  // clock 10: stale release from A#1 rejected; C keeps L1.
  assert.equal(steps[9].accepted, false);
  assert.equal(steps[9].owners["L1"], "C#1");
  assert.ok(sim.verifyMutualExclusion());
});
