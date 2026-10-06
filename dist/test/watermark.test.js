import { test } from "node:test";
import assert from "node:assert/strict";
import { WatermarkTracker, data, idle, active } from "../src/index.js";
test("global watermark is the min over active partitions", () => {
    const result = WatermarkTracker.replay([
        data("p0", 10),
        data("p1", 15),
        data("p2", 12),
    ]);
    assert.equal(result.finalWatermark, 10);
    assert.deepEqual(result.trajectory.map((t) => t.watermark), [10]);
    assert.deepEqual(result.rejections, []);
});
test("idle partition is excluded so the watermark can advance", () => {
    const result = WatermarkTracker.replay([
        data("p0", 5),
        data("p1", 100),
        // p0 stalls; without an idle declaration the watermark stays at 5
        data("p1", 200),
        idle("p0"), // p0 excluded -> p1's 200 becomes publishable
        data("p1", 300),
    ]);
    assert.deepEqual(result.trajectory.map((t) => t.watermark), [5, 200, 300]);
    assert.equal(result.finalWatermark, 300);
});
test("explicit active event re-includes the partition and holds the watermark", () => {
    const result = WatermarkTracker.replay([
        data("p0", 5),
        data("p1", 50),
        idle("p0"), // publishes 50 with p0 excluded
        data("p1", 60), // publishes 60 (p0 still idle)
        active("p0"), // p0 back, still at maxEventTime 5 -> no regression, no new tick
        data("p1", 70), // min(active) = min(5, 70) = 5, already published -> no tick
        data("p0", 65), // min = min(65, 70) = 65
    ]);
    assert.deepEqual(result.trajectory.map((t) => t.watermark), [5, 50, 60, 65]);
});
test("data earlier than the published watermark is rejected and recorded", () => {
    const result = WatermarkTracker.replay([
        data("p0", 10),
        data("p1", 20),
        data("p0", 30), // publishes 20
        data("p1", 7), // late: 7 < 20 -> rejected
        data("p0", 3), // late: 3 < 20 -> rejected
    ]);
    assert.equal(result.rejections.length, 2);
    assert.deepEqual(result.rejections.map((r) => [r.partition, r.eventTime, r.publishedWatermark]), [
        ["p1", 7, 20],
        ["p0", 3, 20],
    ]);
    assert.ok(result.rejections.every((r) => r.reason === "LATE_DATA"));
    // rejected data must not corrupt state: p1 stays at 20, so the watermark
    // remains 20 and can still advance once p1 catches up
    assert.equal(result.finalWatermark, 20);
});
test("data arriving on an idle partition reactivates it", () => {
    const result = WatermarkTracker.replay([
        data("p0", 10),
        data("p1", 40),
        idle("p0"), // publishes 40
        data("p1", 50), // publishes 50 (p0 idle)
        data("p0", 55), // p0 active again; min = min(55, 50) = 50, no tick yet
        data("p1", 60), // publishes 55
    ]);
    assert.deepEqual(result.trajectory.map((t) => t.watermark), [10, 40, 50, 55]);
});
test("no watermark is published until every active partition has data", () => {
    const tracker = new WatermarkTracker();
    tracker.apply(data("p0", 10));
    tracker.apply(active("p1")); // p1 active but no data yet
    assert.equal(tracker.currentWatermark(), 10);
    tracker.apply(idle("p0"));
    assert.equal(tracker.currentWatermark(), 10); // p1 has no data -> nothing new
});
test("replay verifies monotonicity for shuffled interleavings", () => {
    const partitions = ["a", "b", "c"];
    const events = [];
    for (let round = 0; round < 50; round++) {
        for (const p of partitions) {
            events.push(data(p, round * 10 + partitions.indexOf(p)));
        }
        if (round % 7 === 3)
            events.push(idle(partitions[round % 3]));
        if (round % 7 === 5)
            events.push(active(partitions[round % 3]));
    }
    const result = WatermarkTracker.replay(events);
    for (let i = 1; i < result.trajectory.length; i++) {
        assert.ok(result.trajectory[i].watermark >= result.trajectory[i - 1].watermark, "watermark must be monotonically non-decreasing");
    }
    assert.ok(result.trajectory.length > 0);
});
test("trajectory records the event index that caused each publication", () => {
    const result = WatermarkTracker.replay([
        data("p0", 1),
        data("p1", 2),
        data("p0", 5),
        data("p1", 9),
    ]);
    assert.deepEqual(result.trajectory, [
        { atEventIndex: 0, watermark: 1 },
        { atEventIndex: 2, watermark: 2 },
        { atEventIndex: 3, watermark: 5 },
    ]);
});
//# sourceMappingURL=watermark.test.js.map