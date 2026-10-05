import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { SplitLedger } from "../src/ledger.js";
import { split, InfeasibleError } from "../src/split.js";
const RECIPIENTS = [
    { id: "a", weight: 1 },
    { id: "b", weight: 1 },
    { id: "c", weight: 2, min: 5, max: 40 },
];
function sumOf(alloc) {
    let s = 0;
    for (const v of alloc.values())
        s += v;
    return s;
}
describe("multi-order ledger", () => {
    test("allocation accumulates across orders and matches a fresh split", () => {
        const ledger = new SplitLedger(RECIPIENTS);
        ledger.addOrder("o1", 60);
        assert.deepEqual(ledger.getAllocation(), split(60, RECIPIENTS), "single order split");
        ledger.addOrder("o2", 40);
        assert.deepEqual(ledger.getAllocation(), split(100, RECIPIENTS), "two orders re-split the pooled total");
        assert.equal(sumOf(ledger.getAllocation()), 100, "conservation");
    });
    test("global bounds hold across orders", () => {
        const ledger = new SplitLedger(RECIPIENTS);
        ledger.addOrder("o1", 30);
        ledger.addOrder("o2", 30);
        ledger.addOrder("o3", 40);
        const alloc = ledger.getAllocation();
        assert.equal(alloc.get("c"), 40, "c is capped at its global max");
        assert.ok(alloc.get("c") >= 5, "c respects its global min");
        assert.equal(sumOf(alloc), 100, "conservation");
    });
    test("refund undoes the order and re-splits the rest", () => {
        const ledger = new SplitLedger(RECIPIENTS);
        ledger.addOrder("o1", 60);
        ledger.addOrder("o2", 40);
        ledger.addOrder("o3", 20);
        ledger.refund("o1");
        assert.deepEqual(ledger.getAllocation(), split(60, RECIPIENTS), "remaining orders are re-allocated");
        assert.equal(sumOf(ledger.getAllocation()), 60, "conservation");
        assert.deepEqual(ledger.activeOrderIds.sort(), ["o2", "o3"]);
    });
    test("locked amounts do not move across refunds", () => {
        const ledger = new SplitLedger(RECIPIENTS);
        ledger.addOrder("o1", 60);
        ledger.addOrder("o2", 40);
        const before = ledger.getAllocation().get("b");
        ledger.lock("b");
        ledger.refund("o1");
        const after = ledger.getAllocation();
        assert.equal(after.get("b"), before, "locked share is frozen");
        assert.equal(sumOf(after), 40, "conservation with lock");
        // the unlocked recipients split the remainder under their own bounds
        const rest = split(40 - before, [
            { id: "a", weight: 1 },
            { id: "c", weight: 2, min: 5, max: 40 },
        ]);
        assert.equal(after.get("a"), rest.get("a"));
        assert.equal(after.get("c"), rest.get("c"));
    });
    test("refund that would strand a locked amount fails and rolls back", () => {
        const ledger = new SplitLedger([
            { id: "a", weight: 1 },
            { id: "b", weight: 1 },
        ]);
        ledger.addOrder("o1", 60);
        ledger.addOrder("o2", 40);
        ledger.lock("b"); // b holds 50 of 100
        assert.throws(() => ledger.refund("o1"), (err) => err instanceof InfeasibleError);
        assert.equal(ledger.totalActive, 100, "refund rolled back");
        assert.equal(ledger.getAllocation().get("b"), 50);
    });
    test("addOrder that exceeds global maxima fails and rolls back", () => {
        const ledger = new SplitLedger([
            { id: "a", weight: 1, max: 10 },
            { id: "b", weight: 1, max: 10 },
        ]);
        ledger.addOrder("o1", 20);
        assert.throws(() => ledger.addOrder("o2", 1), (err) => err instanceof InfeasibleError);
        assert.equal(ledger.totalActive, 20, "failed order rolled back");
    });
    test("unlock re-joins the recipient to the pooled split", () => {
        const ledger = new SplitLedger(RECIPIENTS);
        ledger.addOrder("o1", 100);
        ledger.lock("a");
        const frozen = ledger.getAllocation().get("a");
        ledger.addOrder("o2", 8);
        assert.equal(ledger.getAllocation().get("a"), frozen);
        ledger.unlock("a");
        assert.deepEqual(ledger.getAllocation(), split(108, RECIPIENTS));
    });
    test("weight 0 with global min is honored across orders", () => {
        const ledger = new SplitLedger([
            { id: "fee", weight: 0, min: 4 },
            { id: "shop", weight: 1 },
        ]);
        ledger.addOrder("o1", 10);
        ledger.addOrder("o2", 10);
        const alloc = ledger.getAllocation();
        assert.equal(alloc.get("fee"), 4);
        assert.equal(alloc.get("shop"), 16);
    });
    test("unknown order refund and double lock are rejected", () => {
        const ledger = new SplitLedger(RECIPIENTS);
        ledger.addOrder("o1", 10);
        assert.throws(() => ledger.refund("nope"));
        ledger.lock("a");
        assert.throws(() => ledger.lock("a"));
        assert.throws(() => ledger.unlock("b"));
    });
});
