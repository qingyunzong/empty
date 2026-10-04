import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  Simulator,
  loadSnapshot,
  replayEvents,
  saveSnapshot,
  verifySnapshot,
  type SimConfig,
  type Snapshot,
} from "../src/index";

const config: SimConfig = {
  segments: ["S1", "S2", "S3"],
  items: { box1: "S1", box2: "S3" },
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
        { kind: "acquire", segment: "S2" },
        { kind: "move", item: "box2", from: "S3", to: "S2" },
        { kind: "release", segment: "S2" },
      ],
    },
  ],
};

test("snapshot of any event can be saved, reloaded and verified", () => {
  const sim = new Simulator(config);
  sim.run();
  assert.ok(sim.events.length > 0);

  // Snapshot at every single event: all must satisfy the invariants.
  for (const event of sim.events) {
    const snap = sim.snapshotAtEvent(event.seq);
    assert.equal(snap.atEvent, event.seq);
    assert.deepEqual(
      verifySnapshot(snap, config),
      [],
      `snapshot at event #${event.seq} (${event.type}) must be consistent`,
    );
  }

  // Save a mid-run snapshot (right after the first move) and reload it.
  const dir = mkdtempSync(join(tmpdir(), "arm-sim-"));
  try {
    const moveSeq = sim.events.find((e) => e.type === "move")!.seq;
    const mid = sim.snapshotAtEvent(moveSeq);
    const file = join(dir, "snapshot.json");
    saveSnapshot(mid, file);
    const loaded = loadSnapshot(file);
    assert.deepEqual(loaded, mid);
    assert.equal(loaded.items.box1, "S2");
    assert.equal(loaded.items.box2, "S3");
    assert.deepEqual(verifySnapshot(loaded, config), []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }

  // Live final state matches a full replay of the event log.
  const replay = replayEvents(config, sim.events);
  assert.deepEqual(replay.violations, []);
  const live = sim.snapshot();
  assert.deepEqual(
    { items: live.items, segments: live.segments, arms: live.arms },
    { items: replay.snapshot.items, segments: replay.snapshot.segments, arms: replay.snapshot.arms },
  );
});

test("verifier flags duplicated and lost items", () => {
  const sim = new Simulator(config);
  sim.run();
  const snap = sim.snapshot();

  const duplicated: Snapshot = JSON.parse(JSON.stringify(snap));
  duplicated.segments.S1.item = "box1"; // box1 also still on S2
  assert.ok(
    verifySnapshot(duplicated, config).some((v) => v.includes("duplicated")),
    "duplicate position must be reported",
  );

  const lost: Snapshot = JSON.parse(JSON.stringify(snap));
  delete lost.items.box2;
  lost.segments.S2.item = null;
  const lostViolations = verifySnapshot(lost, config);
  assert.ok(lostViolations.some((v) => v.includes("lost")));
  assert.ok(lostViolations.some((v) => v.includes("no position")));

  const created: Snapshot = JSON.parse(JSON.stringify(snap));
  created.items.box3 = "S1";
  created.segments.S1.item = "box3";
  assert.ok(verifySnapshot(created, config).some((v) => v.includes("created out of nowhere")));
});

test("verifier flags broken mutual exclusion in a snapshot", () => {
  const sim = new Simulator(config);
  sim.run();
  const mid = sim.snapshotAtEvent(sim.events.find((e) => e.type === "acquire")!.seq);

  const broken: Snapshot = JSON.parse(JSON.stringify(mid));
  broken.arms.B = { status: "running", held: ["S2"], waitingFor: null }; // S2 held by A already
  assert.ok(
    verifySnapshot(broken, config).some((v) => v.includes("segment holder")),
    "conflicting holder must be reported",
  );
});
