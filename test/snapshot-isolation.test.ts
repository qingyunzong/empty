import { test } from "node:test";
import assert from "node:assert/strict";
import {
  Database,
  CommitConflictError,
  type ConflictEvidence,
} from "../src/index.js";

function newDb(...tables: string[]): Database {
  const db = new Database();
  for (const t of tables) db.createTable(t);
  return db;
}

test("read-your-own-writes: staged writes are visible inside the txn", () => {
  const db = newDb("accounts");
  const seed = db.begin();
  seed.set("accounts", "a", "100");
  seed.commit();

  const txn = db.begin();
  txn.set("accounts", "a", "80");
  txn.set("accounts", "b", "20");
  txn.delete("accounts", "a");
  txn.set("accounts", "a", "70");
  assert.equal(txn.get("accounts", "a"), "70");
  assert.equal(txn.get("accounts", "b"), "20");
  txn.delete("accounts", "b");
  assert.equal(txn.get("accounts", "b"), undefined);
  txn.rollback();

  // Nothing leaked: committed state is untouched.
  const check = db.begin();
  assert.equal(check.get("accounts", "a"), "100");
  assert.equal(check.get("accounts", "b"), undefined);
});

test("no dirty reads: uncommitted writes are invisible to other txns", () => {
  const db = newDb("t");
  const writer = db.begin();
  writer.set("t", "k", "dirty");
  const reader = db.begin();
  assert.equal(reader.get("t", "k"), undefined);
  writer.rollback();
});

test("snapshot isolation: reads are repeatable at the start snapshot", () => {
  const db = newDb("t");
  const seed = db.begin();
  seed.set("t", "k", "v1");
  seed.commit();

  const reader = db.begin();
  assert.equal(reader.get("t", "k"), "v1");

  const writer = db.begin();
  writer.set("t", "k", "v2");
  writer.commit();

  // Same key read again: still the snapshot value (repeatable read).
  assert.equal(reader.get("t", "k"), "v1");
  assert.deepEqual(reader.scan("t"), [["k", "v1"]]);

  // A fresh transaction sees the new committed value.
  const fresh = db.begin();
  assert.equal(fresh.get("t", "k"), "v2");
});

test("commit conflict: first-committer-wins, loser gets structured evidence", () => {
  const db = newDb("accounts");
  const seed = db.begin();
  seed.set("accounts", "a", "100");
  const seedRecord = seed.commit();

  const t1 = db.begin();
  const t2 = db.begin();
  t1.set("accounts", "a", "90");
  t2.set("accounts", "a", "80");

  const winner = t1.commit();
  assert.equal(t2.isActive, true);

  let caught: CommitConflictError | undefined;
  try {
    t2.commit();
  } catch (err) {
    if (!(err instanceof CommitConflictError)) throw err;
    caught = err;
  }
  assert.ok(caught, "second committer must abort");

  // Evidence pinpoints the exact race: key, both timestamps, the winner.
  const evidence: ConflictEvidence = caught.conflicts[0]!;
  assert.equal(caught.conflicts.length, 1);
  assert.deepEqual(evidence, {
    table: "accounts",
    key: "a",
    txnStartTs: seedRecord.commitTs, // t2 started right after the seed
    conflictingCommitTs: winner.commitTs,
    attemptedCommitTs: winner.commitTs + 1,
  });
  assert.ok(evidence.conflictingCommitTs > evidence.txnStartTs);
  assert.equal(t2.isActive, false);

  // The winner's value is the one that survived.
  const check = db.begin();
  assert.equal(check.get("accounts", "a"), "90");
});

test("commit validation ignores the read set (SI, not serializable)", () => {
  const db = newDb("t");
  const seed = db.begin();
  seed.set("t", "watched", "0");
  seed.set("t", "mine", "0");
  seed.commit();

  const t1 = db.begin();
  const t2 = db.begin();
  // Both read "watched"; only t2 writes it. t1 writes a disjoint key.
  assert.equal(t1.get("t", "watched"), "0");
  assert.equal(t2.get("t", "watched"), "0");
  t1.set("t", "mine", "1");
  t2.set("t", "watched", "1");

  t2.commit();
  // t1's snapshot is stale on "watched", but it only READ that key: no abort.
  t1.commit();
  assert.equal(db.begin().get("t", "mine"), "1");
});

test("consistent snapshot spans multiple tables atomically", () => {
  const db = newDb("orders", "inventory");
  const seed = db.begin();
  seed.set("orders", "o1", "open");
  seed.set("inventory", "widget", "10");
  seed.commit();

  // Reader starts before the writer commits a two-table transaction.
  const before = db.begin();

  const writer = db.begin();
  writer.set("orders", "o1", "shipped");
  writer.set("inventory", "widget", "9");
  writer.commit();

  // The old snapshot sees a consistent cut across BOTH tables: no mix of
  // half-committed state is ever observable.
  assert.equal(before.get("orders", "o1"), "open");
  assert.equal(before.get("inventory", "widget"), "10");
  assert.deepEqual(before.scan("orders"), [["o1", "open"]]);
  assert.deepEqual(before.scan("inventory"), [["widget", "10"]]);

  // A new snapshot sees both tables move forward together.
  const after = db.begin();
  assert.equal(after.get("orders", "o1"), "shipped");
  assert.equal(after.get("inventory", "widget"), "9");
});

test("multi-table write skew across tables is also possible under SI", () => {
  const db = newDb("roster", "shifts");
  const seed = db.begin();
  seed.set("roster", "on_call_count", "2");
  seed.set("shifts", "alice", "on");
  seed.set("shifts", "bob", "on");
  seed.commit();

  // Alice and Bob each read the shared roster row but write disjoint rows
  // in another table: disjoint write sets -> both commits succeed.
  const alice = db.begin();
  const bob = db.begin();
  assert.equal(alice.get("roster", "on_call_count"), "2");
  assert.equal(bob.get("roster", "on_call_count"), "2");
  alice.set("shifts", "alice", "off");
  bob.set("shifts", "bob", "off");
  alice.commit();
  bob.commit(); // no conflict: write sets {shifts/alice} vs {shifts/bob}

  const check = db.begin();
  assert.equal(check.get("shifts", "alice"), "off");
  assert.equal(check.get("shifts", "bob"), "off");
  assert.equal(check.get("roster", "on_call_count"), "2"); // stale invariant
});

test("deletes commit as tombstones and conflict like writes", () => {
  const db = newDb("t");
  const seed = db.begin();
  seed.set("t", "k", "v");
  seed.commit();

  const deleter = db.begin();
  deleter.delete("t", "k");
  deleter.commit();
  assert.equal(db.begin().get("t", "k"), undefined);

  const t1 = db.begin();
  const t2 = db.begin();
  t1.set("t", "k", "resurrected");
  t2.delete("t", "k");
  t1.commit();
  assert.throws(() => t2.commit(), CommitConflictError);
});
