import { test } from "node:test";
import assert from "node:assert/strict";
import { Simulation, type SimEvent } from "../src/index.js";

function machineEvents(events: readonly SimEvent[], id: string): SimEvent[] {
  return events.filter((e) => e.machine === id);
}

test("machine consumes inputs and produces outputs after processTicks", () => {
  const sim = new Simulation();
  sim.addBuffer({ id: "raw", capacity: 100 });
  sim.addBuffer({ id: "done", capacity: 100 });
  sim.addMachine({
    id: "M1",
    recipe: { inputs: { ore: 2 }, outputs: { bar: 1 }, processTicks: 3 },
    input: "raw",
    output: "done",
  });
  sim.inject("raw", "ore", 4);
  sim.run(7);

  assert.equal(sim.getBuffer("raw").quantity("ore"), 0);
  assert.equal(sim.getBuffer("done").quantity("bar"), 2);
  assert.equal(sim.getMachine("M1").state, "idle");

  const types = machineEvents(sim.events, "M1").map((e) => `${e.tick}:${e.type}`);
  assert.deepEqual(types, [
    "1:started",
    "4:completed",
    "4:unloaded",
    "4:started",
    "7:completed",
    "7:unloaded",
  ]);
});

test("same tick executes completion, unload, then start in order", () => {
  const sim = new Simulation();
  sim.addBuffer({ id: "raw", capacity: 10 });
  sim.addBuffer({ id: "done", capacity: 10 });
  sim.addMachine({
    id: "M1",
    recipe: { inputs: { ore: 1 }, outputs: { bar: 1 }, processTicks: 2 },
    input: "raw",
    output: "done",
  });
  sim.inject("raw", "ore", 2);
  sim.run(3);

  const atTick3 = sim.events.filter((e) => e.tick === 3).map((e) => e.type);
  assert.deepEqual(atTick3, ["completed", "unloaded", "started"]);
});

test("full output buffer blocks the machine; finished goods are held, machine not released early", () => {
  const sim = new Simulation();
  sim.addBuffer({ id: "raw", capacity: 10 });
  sim.addBuffer({ id: "done", capacity: 1 });
  sim.addMachine({
    id: "M1",
    recipe: { inputs: { ore: 1 }, outputs: { bar: 1 }, processTicks: 1 },
    input: "raw",
    output: "done",
  });
  sim.inject("raw", "ore", 3);
  sim.run(3);

  // Job 2 finished at tick 3 but "done" (capacity 1) is full: goods are held.
  const m1 = sim.getMachine("M1");
  assert.equal(m1.state, "blocked");
  assert.equal(m1.heldOutputs.get("bar"), 1);
  assert.equal(sim.getBuffer("done").quantity("bar"), 1);
  assert.equal(sim.getBuffer("raw").quantity("ore"), 1);

  // Input material is available but the blocked machine must not start a job.
  assert.equal(sim.events.filter((e) => e.type === "started").length, 2);
  assert.equal(sim.events.some((e) => e.tick === 3 && e.type === "started"), false);

  // Staying blocked across more ticks; "blocked" is reported once per episode.
  sim.run(2);
  assert.equal(sim.getMachine("M1").state, "blocked");
  assert.equal(sim.events.filter((e) => e.type === "blocked").length, 1);

  // Freeing space lets the same tick unload and then start a new job.
  sim.extract("done", "bar", 1);
  sim.run(1);
  assert.equal(m1.heldOutputs.size, 0);
  assert.equal(m1.state, "processing");
  const atTick6 = sim.events.filter((e) => e.tick === 6).map((e) => e.type);
  assert.deepEqual(atTick6, ["unloaded", "started"]);
});

test("breakdown pauses processing mid-job and resumes with preserved progress", () => {
  const sim = new Simulation();
  sim.addBuffer({ id: "raw", capacity: 10 });
  sim.addBuffer({ id: "done", capacity: 10 });
  sim.addMachine({
    id: "M1",
    recipe: { inputs: { ore: 1 }, outputs: { bar: 1 }, processTicks: 3 },
    input: "raw",
    output: "done",
    failures: [{ tick: 3, repairTicks: 2 }],
  });
  sim.inject("raw", "ore", 1);
  sim.run(7);

  const events = machineEvents(sim.events, "M1").map((e) => `${e.tick}:${e.type}`);
  assert.deepEqual(events, [
    "1:started",
    "3:breakdown",
    "5:repaired",
    "6:completed",
    "6:unloaded",
  ]);

  // Progress made before the breakdown (1 tick) is preserved while down.
  assert.equal(sim.snapshots[2]?.machines[0]?.state, "down");
  assert.equal(sim.snapshots[2]?.machines[0]?.progress, 1);
  assert.equal(sim.snapshots[3]?.machines[0]?.progress, 1);
  assert.equal(sim.snapshots[4]?.machines[0]?.state, "processing");
  assert.equal(sim.getBuffer("done").quantity("bar"), 1);
});

test("breakdown while blocked keeps holding finished goods", () => {
  const sim = new Simulation();
  sim.addBuffer({ id: "raw", capacity: 10 });
  sim.addBuffer({ id: "done", capacity: 1 });
  sim.addMachine({
    id: "M1",
    recipe: { inputs: { ore: 1 }, outputs: { bar: 1 }, processTicks: 1 },
    input: "raw",
    output: "done",
    failures: [{ tick: 2, repairTicks: 1 }],
  });
  sim.inject("raw", "ore", 1);
  sim.inject("done", "bar", 1); // output buffer already full
  sim.run(4);

  const m1 = sim.getMachine("M1");
  assert.equal(m1.state, "blocked");
  assert.equal(m1.heldOutputs.get("bar"), 1);
  assert.equal(sim.getBuffer("done").quantity("bar"), 1);
  const events = machineEvents(sim.events, "M1").map((e) => `${e.tick}:${e.type}`);
  assert.deepEqual(events, ["1:started", "2:breakdown", "3:repaired", "3:completed", "3:blocked"]);
});

test("material conservation holds every tick on a two-machine line with failures", () => {
  const sim = new Simulation();
  sim.addBuffer({ id: "raw", capacity: 8 });
  sim.addBuffer({ id: "mid", capacity: 3 });
  sim.addBuffer({ id: "done", capacity: 4 });
  sim.addMachine({
    id: "M1",
    recipe: { inputs: { ore: 2 }, outputs: { plate: 1 }, processTicks: 3 },
    input: "raw",
    output: "mid",
  });
  sim.addMachine({
    id: "M2",
    recipe: { inputs: { plate: 1 }, outputs: { part: 1 }, processTicks: 2 },
    input: "mid",
    output: "done",
    failures: [
      { tick: 10, repairTicks: 2 },
      { tick: 25, repairTicks: 3 },
    ],
  });

  for (let t = 0; t < 40; t++) {
    if (t % 3 === 0 && sim.getBuffer("raw").free >= 2) sim.inject("raw", "ore", 2);
    if (t % 2 === 0 && sim.getBuffer("done").quantity("part") > 0) {
      sim.extract("done", "part", 1);
    }
    sim.step(); // strictConservation (default) verifies the ledger every tick
  }
  sim.checkConservation();

  // Every extracted part accounts for exactly 2 injected ore.
  const parts = sim.events.filter((e) => e.type === "extracted").length;
  assert.ok(parts > 0, "line should have produced parts");
});

test("conservation check detects material appearing from nowhere", () => {
  const sim = new Simulation();
  sim.addBuffer({ id: "done", capacity: 5 });
  sim.run(1);
  sim.getBuffer("done").add("part", 1); // bypasses the ledger
  assert.throws(() => sim.checkConservation(), /material conservation violated/);
});

test("per-tick snapshots are immutable deep copies of the model state", () => {
  const sim = new Simulation();
  sim.addBuffer({ id: "raw", capacity: 10 });
  sim.addBuffer({ id: "done", capacity: 10 });
  sim.addMachine({
    id: "M1",
    recipe: { inputs: { ore: 1 }, outputs: { bar: 1 }, processTicks: 2 },
    input: "raw",
    output: "done",
  });
  sim.inject("raw", "ore", 2);
  sim.run(2);

  const snap = sim.snapshots[1];
  if (!snap) throw new Error("missing snapshot");
  const frozen = JSON.stringify(snap);
  assert.equal(snap.tick, 2);
  assert.equal(snap.machines[0]?.state, "processing");
  assert.equal(snap.buffers["raw"]?.["ore"], 1);

  sim.run(5); // later ticks must not mutate earlier snapshots
  assert.equal(JSON.stringify(snap), frozen);
  assert.equal(sim.snapshots.length, 7);
});

test("inject and extract are recorded as events with their tick", () => {
  const sim = new Simulation();
  sim.addBuffer({ id: "buf", capacity: 10 });
  sim.inject("buf", "ore", 3);
  sim.run(2);
  sim.extract("buf", "ore", 1);
  const kinds = sim.events.map((e) => `${e.tick}:${e.type}`);
  assert.deepEqual(kinds, ["0:injected", "2:extracted"]);
});
