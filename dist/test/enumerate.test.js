import test from "node:test";
import assert from "node:assert/strict";
import { sortEvents } from "../src/topo.js";
import { enumerateTopoOrders, containsOrder } from "../src/enumerate.js";
const ev = (id, ts, deps = []) => ({ id, source: "S", seq: 0, ts, deps });
test("diamond graph has exactly 2 topological orders; greedy is one of them", () => {
    const events = [
        ev("a", 1),
        ev("b", 2, ["a"]),
        ev("c", 3, ["a"]),
        ev("d", 4, ["b", "c"]),
    ];
    const en = enumerateTopoOrders(events);
    assert.equal(en.orders.length, 2);
    assert.equal(en.truncated, false);
    const greedy = sortEvents(events).order;
    assert.deepEqual(greedy, ["a", "b", "c", "d"]); // ts tie-break picks b before c
    assert.ok(containsOrder(en.orders, greedy));
});
test("enumeration count matches n! for independent events and respects limit", () => {
    const events = [ev("a", 3), ev("b", 1), ev("c", 2)];
    const en = enumerateTopoOrders(events);
    assert.equal(en.orders.length, 6);
    const limited = enumerateTopoOrders(events, 2);
    assert.equal(limited.orders.length, 2);
    assert.equal(limited.truncated, true);
});
test("enumeration excludes events blocked by missing deps", () => {
    const events = [ev("a", 1, ["ghost"]), ev("b", 2)];
    const en = enumerateTopoOrders(events);
    assert.equal(en.totalNodes, 1);
    assert.deepEqual(en.orders, [["b"]]);
});
