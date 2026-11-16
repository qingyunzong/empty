import test from "node:test";
import assert from "node:assert/strict";
import {
  EventStatus,
  StreamEvent,
  WatermarkCoordinator,
  WatermarkPolicy,
  WatermarkState,
} from "../index.ts";

test("per-partition watermark advances monotonically", () => {
  const coordinator = new WatermarkCoordinator({ outOfOrderness: 5 });
  coordinator.addPartition("a");
  coordinator.addPartition("b");

  coordinator.observe("a", 100);
  assert.equal(coordinator.getWatermark(), 95);

  coordinator.observe("b", 80);
  assert.equal(coordinator.getWatermark(), 95, "late first event cannot regress");

  coordinator.observe("a", 90);
  assert.equal(coordinator.getWatermark(), 95, "out-of-order event cannot regress");

  coordinator.observe("b", 120);
  assert.equal(coordinator.getWatermark(), 95, "b now contributes 115, a is still 95");

  coordinator.observe("a", 130);
  assert.equal(coordinator.getWatermark(), 115);

  assert.deepEqual(
    coordinator.getTriggers().map((trigger) => trigger.watermark),
    [95, 115],
  );
});

test("an idle partition no longer blocks the global watermark", () => {
  const coordinator = new WatermarkCoordinator({ outOfOrderness: 10 });
  coordinator.addPartition("fast");
  coordinator.addPartition("slow");

  coordinator.observe("slow", 100);
  coordinator.observe("fast", 1_000);
  assert.equal(coordinator.getWatermark(), 90);

  coordinator.markIdle("slow");
  assert.equal(coordinator.getWatermark(), 990);
  assert.equal(coordinator.activePartitionCount(), 1);

  const state = coordinator.getPartition("slow");
  assert.equal(state?.idle, true);
  assert.equal(state?.idleGeneration, 1);
});

test("reactivation treats stale events as late without moving the watermark back", () => {
  const coordinator = new WatermarkCoordinator({
    outOfOrderness: 10,
    allowedLateness: 20,
  });
  coordinator.addPartition("a");
  coordinator.addPartition("b");
  coordinator.observe("a", 1_000);
  coordinator.observe("b", 100);
  coordinator.markIdle("b");
  assert.equal(coordinator.getWatermark(), 990);

  const stale = coordinator.observe("b", 200);
  assert.equal(stale.reactivated, true);
  assert.equal(stale.late, true);
  assert.equal(stale.tooLate, true);
  assert.equal(stale.status, EventStatus.TooLate);
  assert.equal(stale.accepted, false);
  assert.equal(coordinator.getWatermark(), 990);

  const lateWithinPolicy = coordinator.observe("b", 980);
  assert.equal(lateWithinPolicy.late, true);
  assert.equal(lateWithinPolicy.withinAllowedLateness, true);
  assert.equal(lateWithinPolicy.status, EventStatus.Late);
  assert.equal(lateWithinPolicy.accepted, true);
  assert.equal(coordinator.getWatermark(), 990);

  coordinator.observe("b", 1_100);
  assert.equal(coordinator.getWatermark(), 990, "a still holds the minimum");
  coordinator.observe("a", 1_100);
  assert.equal(coordinator.getWatermark(), 1_090);
  assert.equal(coordinator.getPartition("b")?.idle, false);
});

test("idle timeout uses event arrival time and keeps source watermarks", () => {
  const coordinator = new WatermarkCoordinator(
    new WatermarkPolicy(10, 5, 100),
  );
  coordinator.observe("b", new StreamEvent("b", 500, 900, 1));
  coordinator.observe("a", new StreamEvent("a", 1_000, 1_000, 1));
  assert.equal(coordinator.getWatermark(), 490);

  coordinator.refreshIdle(999);
  assert.equal(coordinator.getWatermark(), 490);
  coordinator.refreshIdle(1_000);
  assert.equal(coordinator.getWatermark(), 990);
  assert.equal(coordinator.partitions.find((part) => part.partition === "b")?.idle, true);
});

test("partition removal advances once and never regresses", () => {
  const coordinator = new WatermarkCoordinator({ outOfOrderness: 0 });
  coordinator.addPartition("a");
  coordinator.addPartition("b");
  coordinator.addPartition("c");
  coordinator.observe("a", 100);
  coordinator.observe("b", 200);
  coordinator.observe("c", 300);
  assert.equal(coordinator.getWatermark(), 100);

  assert.equal(coordinator.removePartition("a"), true);
  assert.equal(coordinator.getWatermark(), 200);
  assert.equal(coordinator.removePartition("a"), false);
  assert.equal(coordinator.getWatermark(), 200);

  coordinator.addPartition("d");
  assert.equal(coordinator.getWatermark(), 200);
  coordinator.observe("d", 50);
  assert.equal(coordinator.getWatermark(), 200, "stale new partition cannot regress");
  coordinator.observe("d", 400);
  assert.equal(coordinator.getWatermark(), 200);

  assert.deepEqual(
    coordinator.getTriggers().map((trigger) => [trigger.sequence, trigger.watermark]),
    [
      [1, 100],
      [2, 200],
    ],
  );
});

test("checkpoint restore preserves partition state and trigger sequence", () => {
  const coordinator = new WatermarkCoordinator({
    outOfOrderness: 5,
    allowedLateness: 50,
  });
  coordinator.observe("a", 100);
  coordinator.observe("b", 80);
  coordinator.markIdle("b");
  const checkpoint = coordinator.snapshot();
  const serialized = JSON.stringify(checkpoint);

  const restored = WatermarkCoordinator.fromSnapshot(serialized);
  assert.equal(restored.getWatermark(), 95);
  assert.equal(restored.getSequence(), coordinator.getSequence());
  assert.deepEqual(restored.getPartition("b"), coordinator.getPartition("b"));

  restored.observe("a", 120);
  assert.equal(restored.getWatermark(), 115);
  assert.equal(restored.getSequence(), coordinator.getSequence() + 1);

  const older = JSON.parse(serialized);
  older.watermark = 10;
  older.sequence = 0;
  coordinator.restore(older);
  assert.equal(coordinator.getWatermark(), 95);
  assert.ok(coordinator.getSequence() >= 1);
});

test("standalone state and policy API classifies lateness", () => {
  const policy = new WatermarkPolicy(60_000, 120_000, 300_000);
  const state = new WatermarkState(policy);

  state.observe(new StreamEvent("sensor-a", 120_000, 1_000, 1));
  assert.equal(state.currentWatermarkMs, 60_000);
  assert.equal(
    state.classify(new StreamEvent("sensor-a", 122_000, 1_010, 2)),
    EventStatus.OnTime,
  );
  assert.equal(
    state.classify(new StreamEvent("sensor-a", 50_000, 1_020, 3)),
    EventStatus.Late,
  );
  assert.equal(
    state.classify(new StreamEvent("sensor-a", -100_000, 1_030, 4)),
    EventStatus.TooLate,
  );
  assert.equal(state.markIdle(301_000), true);

  const coordinator = new WatermarkCoordinator(policy);
  coordinator.observe("p", new StreamEvent("p", 120_000, 1_000, 1));
  assert.equal(coordinator.getWatermark(), 60_000);
  assert.equal(coordinator.globalWatermark(), 60_000);
});

test("event object forms are accepted", () => {
  const coordinator = new WatermarkCoordinator({ outOfOrderness: 1 });
  coordinator.observe({ partitionId: "a", timestamp: 10 });
  coordinator.observe({ key: "b", eventTime: 20 });
  coordinator.observe("c", { event_time_ms: 30, arrival_time_ms: 100 });
  assert.equal(coordinator.getWatermark(), 9);
  assert.equal(coordinator.getPartition("c")?.eventCount, 1);
});

test("kit-style chaining and nullable global watermark", () => {
  const coordinator = WatermarkCoordinator.new({
    outOfOrderness: 5,
    idleTimeout: 10,
  });
  coordinator
    .addPartition("a")
    .observe("a", 100)
    .markIdle("a");

  assert.equal(coordinator.getWatermark(), 95);
  assert.equal(coordinator.globalWatermark(), null);
  assert.equal(coordinator.active_partition_count(), 0);
  assert.equal(coordinator.refresh_idle(1_000), coordinator);
});

test("restore derives the next trigger sequence from restored history", () => {
  const restored = WatermarkCoordinator.fromSnapshot({
    version: 1,
    watermark: 100,
    partitions: {
      p: {
        id: "p",
        maxTimestamp: 100,
        outOfOrderness: 0,
        allowedLateness: 0,
        idle: false,
        idleGeneration: 0,
        eventCount: 1,
        lateEventCount: 0,
        lastEventTimestamp: 100,
      },
    },
    triggers: [
      {
        sequence: 7,
        seq: 7,
        watermark: 100,
        globalWatermark: 100,
        previousWatermark: 99,
        reason: "event",
        type: "event",
      },
    ],
  });
  assert.equal(restored.getSequence(), 7);
  restored.observe("p", 110);
  assert.equal(restored.getSequence(), 8);
  assert.equal(restored.getWatermark(), 110);
});
