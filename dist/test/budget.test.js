import { test } from "node:test";
import assert from "node:assert/strict";
import { BudgetError, BudgetSystem } from "../src/budget.js";
test("root creation and duplicate id rejection", () => {
    const sys = new BudgetSystem();
    sys.createRoot("root", 1000);
    assert.equal(sys.getAvailable("root"), 1000);
    assert.throws(() => sys.createRoot("root", 5), BudgetError);
    assert.throws(() => sys.createRoot("bad", -1), BudgetError);
    assert.throws(() => sys.createRoot("bad2", 1.5), BudgetError);
});
test("grant moves quota from parent to child", () => {
    const sys = new BudgetSystem();
    sys.createRoot("root", 1000);
    sys.grant("root", "child", 300);
    assert.equal(sys.getAvailable("root"), 700);
    assert.equal(sys.getAvailable("child"), 300);
    assert.equal(sys.parentOf("child"), "root");
    assert.throws(() => sys.grant("root", "child", 1), BudgetError); // id reuse
    assert.throws(() => sys.grant("root", "c2", 701), BudgetError); // insufficient
    assert.throws(() => sys.grant("root", "c3", 0), BudgetError); // non-positive
    assert.throws(() => sys.grant("ghost", "c4", 1), BudgetError); // unknown parent
});
test("spend deducts child quota and is recorded in parent's total consumption", () => {
    const sys = new BudgetSystem();
    sys.createRoot("root", 1000);
    sys.grant("root", "a", 400);
    sys.grant("a", "a1", 150);
    const s1 = sys.spend("a1", 60);
    const s2 = sys.spend("a", 100);
    assert.notEqual(s1, s2);
    assert.equal(sys.getAvailable("a1"), 90);
    assert.equal(sys.getAvailable("a"), 150); // 400 - 150 granted to a1 - 100 spent
    assert.equal(sys.getConsumed("a1"), 60);
    assert.equal(sys.getConsumed("a"), 100);
    // total consumption rolls up the tree
    assert.equal(sys.getTotalConsumed("a"), 160);
    assert.equal(sys.getTotalConsumed("root"), 160);
    assert.equal(sys.getTotalConsumed("a1"), 60);
    assert.throws(() => sys.spend("a1", 91), BudgetError); // insufficient
    assert.throws(() => sys.spend("a1", -5), BudgetError);
});
test("refund works once against the original spend id only", () => {
    const sys = new BudgetSystem();
    sys.createRoot("root", 500);
    sys.grant("root", "c", 200);
    const spendId = sys.spend("c", 80);
    assert.equal(sys.getAvailable("c"), 120);
    assert.equal(sys.getTotalConsumed("root"), 80);
    sys.refund(spendId);
    assert.equal(sys.getAvailable("c"), 200);
    assert.equal(sys.getConsumed("c"), 0);
    assert.equal(sys.getTotalConsumed("root"), 0);
    assert.equal(sys.getSpend(spendId)?.refunded, true);
    // second refund of the same id is rejected
    assert.throws(() => sys.refund(spendId), BudgetError);
    // unknown / fabricated ids are rejected
    assert.throws(() => sys.refund("spend-999"), BudgetError);
    assert.throws(() => sys.refund(""), BudgetError);
    // state unchanged by failed refunds
    assert.equal(sys.getAvailable("c"), 200);
});
test("refund after revoke credits the nearest active ancestor", () => {
    const sys = new BudgetSystem();
    sys.createRoot("root", 500);
    sys.grant("root", "c", 200);
    const spendId = sys.spend("c", 80); // 80 consumed, 120 left
    sys.revoke("c"); // 120 unused goes back to root
    assert.equal(sys.getAvailable("root"), 420);
    sys.refund(spendId); // spender revoked -> credit root, still exactly once
    assert.equal(sys.getAvailable("root"), 500);
    assert.equal(sys.getTotalConsumed("root"), 0);
    assert.throws(() => sys.refund(spendId), BudgetError);
});
test("revoke returns unused quota to parent and disables the token", () => {
    const sys = new BudgetSystem();
    sys.createRoot("root", 1000);
    sys.grant("root", "c", 400);
    sys.spend("c", 150);
    const returned = sys.revoke("c");
    assert.equal(returned, 250);
    assert.equal(sys.getAvailable("root"), 850);
    assert.equal(sys.getAvailable("c"), 0);
    assert.equal(sys.isActive("c"), false);
    // consumed quota stays consumed
    assert.equal(sys.getTotalConsumed("root"), 150);
    // revoked token can no longer operate
    assert.throws(() => sys.spend("c", 1), BudgetError);
    assert.throws(() => sys.grant("c", "gc", 1), BudgetError);
    assert.throws(() => sys.transfer("c", "root", 1), BudgetError);
    assert.throws(() => sys.transfer("root", "c", 1), BudgetError);
    // double revoke and root revoke are rejected
    assert.throws(() => sys.revoke("c"), BudgetError);
    assert.throws(() => sys.revoke("root"), BudgetError);
    assert.throws(() => sys.revoke("ghost"), BudgetError);
});
test("transfer moves quota between active tokens", () => {
    const sys = new BudgetSystem();
    sys.createRoot("root", 100);
    sys.grant("root", "a", 60);
    sys.grant("root", "b", 20);
    sys.transfer("a", "b", 25);
    assert.equal(sys.getAvailable("a"), 35);
    assert.equal(sys.getAvailable("b"), 45);
    assert.throws(() => sys.transfer("a", "b", 36), BudgetError);
    assert.throws(() => sys.transfer("a", "a", 1), BudgetError);
});
test("batch transfer is atomic: one bad op rejects the whole batch", () => {
    const sys = new BudgetSystem();
    sys.createRoot("root", 500);
    sys.grant("root", "a", 100);
    sys.grant("root", "b", 100);
    sys.grant("root", "c", 100);
    const before = [sys.getAvailable("a"), sys.getAvailable("b"), sys.getAvailable("c"), sys.getAvailable("root")];
    assert.throws(() => sys.transferBatch([
        { from: "a", to: "b", amount: 40 },
        { from: "b", to: "c", amount: 50 },
        { from: "c", to: "a", amount: 1000 }, // insufficient -> whole batch fails
    ]), BudgetError);
    assert.deepEqual([sys.getAvailable("a"), sys.getAvailable("b"), sys.getAvailable("c"), sys.getAvailable("root")], before);
    // a valid batch applies in order (chained: b spends what it just received)
    sys.transferBatch([
        { from: "a", to: "b", amount: 40 },
        { from: "b", to: "c", amount: 130 },
    ]);
    assert.equal(sys.getAvailable("a"), 60);
    assert.equal(sys.getAvailable("b"), 10);
    assert.equal(sys.getAvailable("c"), 230);
});
test("conservation: available + consumed always equals initial quota", () => {
    const sys = new BudgetSystem();
    sys.createRoot("root", 1000);
    sys.grant("root", "a", 400);
    sys.grant("root", "b", 300);
    sys.grant("a", "a1", 150);
    const s1 = sys.spend("a1", 60);
    sys.spend("b", 120);
    sys.spend("root", 50);
    sys.revoke("a1");
    sys.transferBatch([
        { from: "b", to: "a", amount: 30 },
        { from: "a", to: "root", amount: 10 },
    ]);
    sys.refund(s1);
    assert.equal(sys.totalAvailable() + sys.getTotalConsumed("root"), 1000);
});
