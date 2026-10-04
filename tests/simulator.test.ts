import { test } from "node:test";
import assert from "node:assert/strict";
import { Simulator, replayEvents, type SimConfig, type SimEvent } from "../src/index";

function byType(events: SimEvent[], type: SimEvent["type"]): SimEvent[] {
  return events.filter((e) => e.type === type);
}

test("two arms hand an item over shared segments; replay is clean", () => {
  const config: SimConfig = {
    segments: ["S1", "S2", "S3"],
    items: { box1: "S1" },
    arms: [
      {
        id: "A",
        program: [
          { kind: "acquire", segment: "S2" },
          { kind: "move", item: "box1", from: "S1", to: "S2" },
          { kind: "release", segment: "S2" },
        ],
      },
      {
        id: "B",
        program: [
          { kind: "acquire", segment: "S3" },
          { kind: "acquire", segment: "S2" },
          { kind: "move", item: "box1", from: "S2", to: "S3" },
          { kind: "release", segment: "S3" },
          { kind: "release", segment: "S2" },
        ],
      },
    ],
  };
  const sim = new Simulator(config);
  sim.run();

  assert.equal(sim.armStatus("A"), "done");
  assert.equal(sim.armStatus("B"), "done");
  assert.equal(sim.itemAt("box1"), "S3");

  // B had to wait for A to release S2 before acquiring it.
  const block = byType(sim.events, "block");
  assert.equal(block.length, 1);
  assert.equal(block[0].arm, "B");
  const bAcquireS2 = sim.events.find(
    (e) => e.type === "acquire" && e.arm === "B" && e.segment === "S2",
  )!;
  assert.ok(block[0].seq < bAcquireS2.seq, "B acquires S2 only after blocking");

  const replay = replayEvents(config, sim.events);
  assert.deepEqual(replay.violations, []);
});

test("shared segment is mutually exclusive", () => {
  const config: SimConfig = {
    segments: ["S1"],
    items: {},
    arms: [
      { id: "A", program: [{ kind: "acquire", segment: "S1" }, { kind: "release", segment: "S1" }] },
      { id: "B", program: [{ kind: "acquire", segment: "S1" }, { kind: "release", segment: "S1" }] },
    ],
  };
  const sim = new Simulator(config);
  sim.run();

  assert.equal(sim.armStatus("A"), "done");
  assert.equal(sim.armStatus("B"), "done");
  const acquires = byType(sim.events, "acquire").map((e) => e.arm);
  assert.deepEqual(acquires, ["A", "B"]);
  // No overlap: A's release comes before B's acquire.
  const aRelease = sim.events.find((e) => e.type === "release" && e.arm === "A")!;
  const bAcquire = sim.events.find((e) => e.type === "acquire" && e.arm === "B")!;
  assert.ok(aRelease.seq < bAcquire.seq);
  assert.deepEqual(replayEvents(config, sim.events).violations, []);
});

test("failure releases only acquired resources, in reverse order", () => {
  const config: SimConfig = {
    segments: ["S1", "S2"],
    items: {},
    arms: [
      {
        id: "A",
        program: [
          { kind: "acquire", segment: "S1" },
          { kind: "acquire", segment: "S2" },
          { kind: "fail", reason: "gripper fault" },
        ],
      },
      { id: "B", program: [{ kind: "acquire", segment: "S1" }, { kind: "release", segment: "S1" }] },
    ],
  };
  const sim = new Simulator(config);
  sim.run();

  assert.equal(sim.armStatus("A"), "failed");
  assert.equal(sim.armStatus("B"), "done");

  const rollback = byType(sim.events, "rollback-release");
  assert.deepEqual(
    rollback.map((e) => e.segment),
    ["S2", "S1"],
    "rollback must unwind LIFO: S2 before S1",
  );
  assert.ok(rollback.every((e) => e.arm === "A"), "only A's own resources are released");

  // B was waiting on S1 and got unblocked by A's rollback.
  const bAcquire = sim.events.find((e) => e.type === "acquire" && e.arm === "B")!;
  assert.ok(rollback[1].seq < bAcquire.seq);

  const end = sim.snapshot();
  assert.ok(Object.values(end.segments).every((s) => s.holder === null));
  assert.deepEqual(replayEvents(config, sim.events).violations, []);
});

test("illegal move fails the arm and rolls back its held segments", () => {
  const config: SimConfig = {
    segments: ["S1", "S2", "S3"],
    items: { box1: "S1" },
    arms: [
      {
        id: "A",
        program: [
          { kind: "acquire", segment: "S2" },
          { kind: "move", item: "box1", from: "S1", to: "S3" },
        ],
      },
    ],
  };
  const sim = new Simulator(config);
  sim.run();

  assert.equal(sim.armStatus("A"), "failed");
  const fail = byType(sim.events, "fail")[0];
  assert.match(fail.reason!, /does not hold target segment S3/);
  assert.deepEqual(
    byType(sim.events, "rollback-release").map((e) => e.segment),
    ["S2"],
  );
  // Item never moved; conservation holds.
  assert.equal(sim.itemAt("box1"), "S1");
  assert.deepEqual(replayEvents(config, sim.events).violations, []);
});
