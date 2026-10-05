import { test } from "node:test";
import assert from "node:assert/strict";
import { BudgetLedger, BudgetError } from "../src/budget.js";

test("parent allocates quota to child; child consumption rolls up to parent totals", () => {
  const ledger = new BudgetLedger();
  ledger.createRoot("root", 1000);
  ledger.allocate("root", "child", 400);
  assert.equal(ledger.get("root").quota, 600);
  assert.equal(ledger.get("child").quota, 400);

  ledger.consume("child", 150, "c1");
  assert.equal(ledger.get("child").quota, 250);
  assert.equal(ledger.get("child").consumed, 150);
  assert.equal(ledger.get("child").totalConsumed, 150);
  assert.equal(ledger.get("root").totalConsumed, 150);
  assert.equal(ledger.get("root").consumed, 0);
});

test("nested allocation and multi-level rollup", () => {
  const ledger = new BudgetLedger();
  ledger.createRoot("root", 1000);
  ledger.allocate("root", "a", 500);
  ledger.allocate("a", "b", 200);
  ledger.consume("b", 80, "c1");
  assert.equal(ledger.get("b").totalConsumed, 80);
  assert.equal(ledger.get("a").totalConsumed, 80);
  assert.equal(ledger.get("root").totalConsumed, 80);
  assert.equal(ledger.get("a").quota, 300);
});

test("allocation beyond parent quota fails", () => {
  const ledger = new BudgetLedger();
  ledger.createRoot("root", 100);
  assert.throws(() => ledger.allocate("root", "a", 101), BudgetError);
  ledger.allocate("root", "a", 60);
  assert.throws(() => ledger.allocate("root", "b", 41), BudgetError);
});

test("consumption beyond quota fails and does not mutate", () => {
  const ledger = new BudgetLedger();
  ledger.createRoot("root", 100);
  ledger.allocate("root", "a", 50);
  assert.throws(() => ledger.consume("a", 51, "c1"), BudgetError);
  assert.equal(ledger.get("a").quota, 50);
  assert.equal(ledger.get("root").totalConsumed, 0);
});

test("refund restores quota and rolls back ancestor totals", () => {
  const ledger = new BudgetLedger();
  ledger.createRoot("root", 1000);
  ledger.allocate("root", "a", 300);
  ledger.consume("a", 120, "c1");
  ledger.refund("c1");
  assert.equal(ledger.get("a").quota, 300);
  assert.equal(ledger.get("a").consumed, 0);
  assert.equal(ledger.get("root").totalConsumed, 0);
});

test("refund only matches the original id and only once", () => {
  const ledger = new BudgetLedger();
  ledger.createRoot("root", 1000);
  ledger.allocate("root", "a", 300);
  ledger.consume("a", 120, "c1");
  assert.throws(() => ledger.refund("nope"), BudgetError);
  ledger.refund("c1");
  assert.throws(() => ledger.refund("c1"), BudgetError);
});

test("consumption ids are unique", () => {
  const ledger = new BudgetLedger();
  ledger.createRoot("root", 1000);
  ledger.consume("root", 10, "c1");
  assert.throws(() => ledger.consume("root", 10, "c1"), BudgetError);
});

test("revoking a child returns unused quota of its subtree to the parent", () => {
  const ledger = new BudgetLedger();
  ledger.createRoot("root", 1000);
  ledger.allocate("root", "a", 400);
  ledger.allocate("a", "b", 150);
  ledger.consume("b", 50, "c1");
  // subtree unused: a=250, b=100 -> 350 back to root
  ledger.revoke("a");
  assert.equal(ledger.get("root").quota, 950);
  assert.equal(ledger.get("a").quota, 0);
  assert.equal(ledger.get("b").quota, 0);
  assert.equal(ledger.get("a").revoked, true);
  assert.equal(ledger.get("b").revoked, true);
  // revoked tokens can no longer operate
  assert.throws(() => ledger.consume("b", 1, "c2"), BudgetError);
  assert.throws(() => ledger.allocate("a", "c", 1), BudgetError);
  assert.throws(() => ledger.refund("c1"), BudgetError);
  // consumption history stays recorded on ancestors
  assert.equal(ledger.get("root").totalConsumed, 50);
});

test("cannot revoke root or revoke twice", () => {
  const ledger = new BudgetLedger();
  ledger.createRoot("root", 100);
  ledger.allocate("root", "a", 50);
  assert.throws(() => ledger.revoke("root"), BudgetError);
  ledger.revoke("a");
  assert.throws(() => ledger.revoke("a"), BudgetError);
});

test("batch transfer applies all transfers", () => {
  const ledger = new BudgetLedger();
  ledger.createRoot("root", 1000);
  ledger.allocate("root", "a", 300);
  ledger.allocate("root", "b", 200);
  ledger.transferBatch([
    { from: "a", to: "b", amount: 100 },
    { from: "b", to: "root", amount: 50 },
  ]);
  assert.equal(ledger.get("a").quota, 200);
  assert.equal(ledger.get("b").quota, 250);
  assert.equal(ledger.get("root").quota, 550);
});

test("batch transfer is atomic: one failure rolls back everything", () => {
  const ledger = new BudgetLedger();
  ledger.createRoot("root", 1000);
  ledger.allocate("root", "a", 300);
  ledger.allocate("root", "b", 200);
  assert.throws(
    () =>
      ledger.transferBatch([
        { from: "a", to: "b", amount: 100 }, // valid
        { from: "b", to: "root", amount: 999 }, // insufficient
      ]),
    BudgetError,
  );
  assert.equal(ledger.get("a").quota, 300);
  assert.equal(ledger.get("b").quota, 200);
  assert.equal(ledger.get("root").quota, 500);
  // unknown token also aborts the whole batch
  assert.throws(
    () => ledger.transferBatch([{ from: "a", to: "ghost", amount: 1 }]),
    BudgetError,
  );
  assert.equal(ledger.get("a").quota, 300);
});

test("batch transfer nets multiple transfers on the same token", () => {
  const ledger = new BudgetLedger();
  ledger.createRoot("root", 300);
  ledger.allocate("root", "a", 100);
  ledger.allocate("root", "b", 100);
  // a sends 100 to b but receives 60 back within the same batch: net -40, valid
  ledger.transferBatch([
    { from: "a", to: "b", amount: 100 },
    { from: "b", to: "a", amount: 60 },
  ]);
  assert.equal(ledger.get("a").quota, 60);
  assert.equal(ledger.get("b").quota, 140);
});
