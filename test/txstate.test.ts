import assert from "node:assert/strict";
import test from "node:test";
import { BudgetExceededError, TxState } from "../src/txstate";

test("inner rollback undoes only its own layer", () => {
  const tx = new TxState();
  tx.set("a", 1);
  tx.begin();
  tx.set("a", 2);
  tx.set("b", 10);
  tx.rollback();
  assert.equal(tx.get("a"), 1);
  assert.equal(tx.get("b"), 0);
});

test("inner commit merges into parent; outer rollback undoes both", () => {
  const tx = new TxState();
  tx.set("a", 1);
  tx.begin();
  tx.add("a", 5);
  tx.set("b", 7);
  tx.commit();
  assert.equal(tx.get("a"), 6);
  assert.equal(tx.get("b"), 7);
  tx.rollback();
  assert.equal(tx.get("a"), 0);
  assert.equal(tx.get("b"), 0);
});

test("staged actions publish only on outermost commit, in order", () => {
  const tx = new TxState();
  tx.stage({ kind: "emit", payload: 1 });
  tx.begin();
  tx.stage({ kind: "emit", payload: 2 });
  tx.commit();
  assert.deepEqual(tx.published(), []);
  tx.commit();
  assert.deepEqual(tx.published(), [
    { kind: "emit", payload: 1 },
    { kind: "emit", payload: 2 },
  ]);
});

test("rollback discards the staged actions of its layer", () => {
  const tx = new TxState();
  tx.stage({ kind: "emit", payload: 1 });
  tx.begin();
  tx.stage({ kind: "emit", payload: 2 });
  tx.rollback();
  tx.commit();
  assert.deepEqual(tx.published(), [{ kind: "emit", payload: 1 }]);
});

test("root rollback restores the last committed baseline", () => {
  const tx = new TxState();
  tx.set("a", 3);
  tx.commit();
  tx.set("a", 9);
  tx.stage({ kind: "emit", payload: 1 });
  tx.rollback();
  assert.equal(tx.get("a"), 3);
  tx.commit();
  assert.deepEqual(tx.published(), []);
});

test("capture returns value and commits its savepoint on success", () => {
  const tx = new TxState();
  const result = tx.capture((t) => {
    t.set("a", 4);
    return "done";
  });
  assert.deepEqual(result, { ok: true, value: "done" });
  assert.equal(tx.get("a"), 4);
  assert.equal(tx.depth(), 1);
});

test("capture rolls back only its own layer on exception", () => {
  const tx = new TxState();
  tx.set("a", 1);
  const boom = new Error("boom");
  const result = tx.capture((t) => {
    t.set("a", 2);
    t.set("b", 5);
    throw boom;
  });
  assert.deepEqual(result, { ok: false, error: boom });
  assert.equal(tx.get("a"), 1);
  assert.equal(tx.get("b"), 0);
  assert.equal(tx.depth(), 1);
});

test("nested capture: inner failure does not discard outer work", () => {
  const tx = new TxState();
  const outer = tx.capture((t) => {
    t.set("a", 1);
    const inner = t.capture((u) => {
      u.set("b", 2);
      throw new Error("inner");
    });
    assert.equal(inner.ok, false);
    t.set("c", 3);
    return "outer";
  });
  assert.deepEqual(outer, { ok: true, value: "outer" });
  assert.equal(tx.get("a"), 1);
  assert.equal(tx.get("b"), 0);
  assert.equal(tx.get("c"), 3);
});

test("budget abort rolls back everything and discards staged actions", () => {
  const tx = new TxState({ budget: 4 });
  tx.set("a", 1);
  tx.commit();
  tx.begin();
  tx.set("a", 2);
  tx.stage({ kind: "emit", payload: 1 });
  tx.set("b", 5);
  assert.throws(
    () => tx.set("c", 6),
    (error: unknown) => error instanceof BudgetExceededError,
  );
  assert.equal(tx.get("a"), 1);
  assert.equal(tx.get("b"), 0);
  assert.equal(tx.get("c"), 0);
  assert.equal(tx.depth(), 1);
  tx.commit();
  assert.deepEqual(tx.published(), []);
});

test("store stays usable with a fresh budget after abort", () => {
  const tx = new TxState({ budget: 1 });
  tx.set("a", 1);
  assert.throws(() => tx.set("b", 2), BudgetExceededError);
  assert.equal(tx.get("a"), 0);
  tx.set("a", 7);
  tx.commit();
  assert.equal(tx.get("a"), 7);
});

test("capture never swallows BudgetExceededError", () => {
  const tx = new TxState({ budget: 2 });
  tx.set("a", 1);
  assert.throws(
    () =>
      tx.capture((t) => {
        t.set("b", 2);
        t.set("c", 3);
      }),
    BudgetExceededError,
  );
  assert.equal(tx.get("a"), 0);
  assert.equal(tx.depth(), 1);
});

test("non-integer values are rejected without changing state", () => {
  const tx = new TxState();
  tx.set("a", 1);
  assert.throws(() => tx.set("a", 1.5), TypeError);
  assert.throws(() => tx.add("a", Number.NaN), TypeError);
  assert.equal(tx.get("a"), 1);
});
