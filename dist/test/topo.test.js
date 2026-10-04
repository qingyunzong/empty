import test from "node:test";
import assert from "node:assert/strict";
import { sortEvents } from "../src/topo.js";
const ev = (id, source, seq, ts, deps = []) => ({ id, source, seq, ts, deps });
test("greedy picks smallest (ts, source, seq) candidate each round", () => {
    const events = [
        ev("a1", "A", 1, 5),
        ev("b1", "B", 1, 3),
        ev("a2", "A", 2, 1, ["a1"]), // smaller ts but blocked until a1 emitted
        ev("b2", "B", 2, 2, ["b1"]),
    ];
    const r = sortEvents(events);
    // round1: candidates a1(ts5), b1(ts3) -> b1; round2: a1(ts5), b2(ts2) -> b2;
    // round3: a1; round4: a2
    assert.deepEqual(r.order, ["b1", "b2", "a1", "a2"]);
    assert.deepEqual(r.cycles, []);
    assert.deepEqual(r.missing, []);
});
test("timestamps need not be causally monotonic", () => {
    const events = [ev("x", "A", 1, 100), ev("y", "B", 1, 1, ["x"])];
    const r = sortEvents(events);
    assert.deepEqual(r.order, ["x", "y"]); // y has smaller ts but must follow x
});
test("source id breaks ts ties, seq breaks source ties", () => {
    const events = [
        ev("s2", "B", 7, 1),
        ev("s1", "A", 9, 1),
        ev("s3", "A", 3, 1),
    ];
    const r = sortEvents(events);
    assert.deepEqual(r.order, ["s3", "s1", "s2"]); // (1,A,3) < (1,A,9) < (1,B,7)
});
test("missing dependency evidence and transitive blocking", () => {
    const events = [
        ev("a", "A", 1, 1, ["ghost"]),
        ev("b", "A", 2, 2, ["a"]),
        ev("c", "B", 1, 3),
    ];
    const r = sortEvents(events);
    assert.deepEqual(r.order, ["c"]);
    assert.deepEqual(r.missing, [{ eventId: "a", missingDep: "ghost" }]);
    assert.deepEqual(r.missingIndex.get("ghost"), ["a"]);
    assert.deepEqual(r.blocked, ["a", "b"]); // b blocked transitively
});
test("cycle evidence reports a concrete cycle path", () => {
    const events = [
        ev("a", "A", 1, 1, ["c"]),
        ev("b", "A", 2, 2, ["a"]),
        ev("c", "A", 3, 3, ["b"]),
        ev("d", "B", 1, 4),
    ];
    const r = sortEvents(events);
    assert.deepEqual(r.order, ["d"]);
    assert.equal(r.cycles.length, 1);
    const cyc = r.cycles[0];
    assert.equal(cyc[0], cyc[cyc.length - 1]); // closed loop
    assert.equal(new Set(cyc.slice(0, -1)).size, 3); // visits a, b, c
});
test("duplicate ids are rejected", () => {
    assert.throws(() => sortEvents([ev("a", "A", 1, 1), ev("a", "B", 1, 2)]), /duplicate/);
});
