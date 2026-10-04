import test from "node:test";
import assert from "node:assert/strict";
import { LogStore } from "../src/store.js";
const ev = (id, ts, deps = []) => ({ id, source: "S", seq: 0, ts, deps });
function sampleStore() {
    const s = new LogStore([
        ev("a", 1),
        ev("b", 2, ["a"]),
        ev("c", 3, ["ghost"]), // missing dep -> blocked
        ev("d", 4),
    ]);
    s.publish(1);
    return s;
}
test("snapshot round-trip preserves order, ready candidates and missing index", () => {
    const s = sampleStore();
    const snap = s.toSnapshot();
    assert.deepEqual(snap.ready, ["b", "d"]); // both have all known deps published
    const restored = LogStore.fromSnapshot(snap);
    assert.deepEqual(restored.order, s.order);
    assert.deepEqual(restored.publishedPrefix, s.publishedPrefix);
    assert.deepEqual(restored.toSnapshot(), snap);
});
test("snapshot equals full rebuild from events + published prefix", () => {
    const s = sampleStore();
    const snap = s.toSnapshot();
    const rebuilt = new LogStore(snap.events, snap.published);
    assert.deepEqual(rebuilt.order, s.order);
    assert.deepEqual(rebuilt.readyFrontier(), snap.ready);
});
test("tampered snapshot fails integrity verification", () => {
    const snap = sampleStore().toSnapshot();
    const bad = JSON.parse(JSON.stringify(snap));
    bad.unpublishedOrder = [...bad.unpublishedOrder].reverse();
    assert.throws(() => LogStore.fromSnapshot(bad), /integrity/);
});
test("missing index records dependents of unknown deps", () => {
    const snap = sampleStore().toSnapshot();
    assert.deepEqual(snap.missingIndex, { ghost: ["c"] });
});
