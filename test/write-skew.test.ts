import { test } from "node:test";
import assert from "node:assert/strict";
import { Database, CommitConflictError } from "../src/index.js";

// Classic write skew: two on-call doctors, invariant "at least one doctor
// stays on call". Each transaction reads BOTH rows (so its decision is
// based on a snapshot that includes the other row) but writes only its
// OWN row. Write sets are disjoint, so SI commit validation (write-set
// only) lets both commit and the invariant is silently broken.
test("write skew happens under SI and is explicitly demonstrated", () => {
  const db = new Database();
  db.createTable("doctors");
  const seed = db.begin();
  seed.set("doctors", "alice", "on_call");
  seed.set("doctors", "bob", "on_call");
  seed.commit();

  const onCall = (txn: ReturnType<Database["begin"]>): number =>
    txn.scan("doctors").filter(([, v]) => v === "on_call").length;

  const alice = db.begin();
  const bob = db.begin();

  // Both observe "2 doctors on call", so each believes it is safe to leave.
  assert.equal(onCall(alice), 2);
  assert.equal(onCall(bob), 2);

  alice.set("doctors", "alice", "off");
  bob.set("doctors", "bob", "off");

  // Disjoint write sets {doctors/alice} and {doctors/bob}: no conflict.
  const r1 = alice.commit();
  const r2 = bob.commit();
  assert.ok(r1.commitTs < r2.commitTs);

  // INVARIANT VIOLATED: nobody is on call. This is the write-skew anomaly
  // that snapshot isolation permits and serializable isolation forbids.
  const final = db.begin();
  assert.equal(final.get("doctors", "alice"), "off");
  assert.equal(final.get("doctors", "bob"), "off");
  assert.equal(onCall(final), 0);
});

test("contrast: touching a shared row serializes the same workload", () => {
  const db = new Database();
  db.createTable("doctors");
  const seed = db.begin();
  seed.set("doctors", "alice", "on_call");
  seed.set("doctors", "bob", "on_call");
  seed.set("doctors", "on_call_count", "2");
  seed.commit();

  const alice = db.begin();
  const bob = db.begin();
  // Materialize the conflict: both update the shared counter row.
  alice.set("doctors", "alice", "off");
  alice.set("doctors", "on_call_count", "1");
  bob.set("doctors", "bob", "off");
  bob.set("doctors", "on_call_count", "1");

  alice.commit();
  // Overlapping write set on "on_call_count" -> first-committer-wins abort.
  assert.throws(() => bob.commit(), CommitConflictError);

  const final = db.begin();
  assert.equal(final.get("doctors", "alice"), "off");
  assert.equal(final.get("doctors", "bob"), "on_call"); // invariant preserved
});
