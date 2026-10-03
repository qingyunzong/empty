import test from "node:test";
import assert from "node:assert/strict";
import { computeDigest } from "../src/merkle.js";
import {
  ReplicaError,
  deleteRecord,
  diffSnapshot,
  emptyState,
  mergeSnapshot,
  resolveRecord,
  snapshot,
  upsert,
  verifySnapshot,
} from "../src/replica.js";

test("anti-entropy: missing records and tombstones are found, digests converge after repair", () => {
  const a = emptyState("a");
  const b = emptyState("b");

  upsert(a, { id: "r1", amountA: 10, amountB: 10 });
  upsert(a, { id: "r2", amountA: 20, amountB: 20 });
  upsert(a, { id: "r4", amountA: 40, amountB: 40 });
  deleteRecord(a, "r4");

  upsert(b, { id: "r2", amountA: 20, amountB: 20 });
  upsert(b, { id: "r3", amountA: 30, amountB: 30 });

  const snapA = snapshot(a);
  const snapB = snapshot(b);

  const diffAtB = diffSnapshot(b, snapA);
  assert.equal(diffAtB.equal, false);
  assert.deepEqual(diffAtB.missingRecords, ["r1"]);
  assert.deepEqual(diffAtB.missingTombstones, ["r4"]);

  const diffAtA = diffSnapshot(a, snapB);
  assert.equal(diffAtA.equal, false);
  assert.deepEqual(diffAtA.missingRecords, ["r3"]);
  assert.deepEqual(diffAtA.missingTombstones, []);

  mergeSnapshot(a, snapB);
  mergeSnapshot(b, snapA);

  assert.equal(computeDigest(a), computeDigest(b));
  assert.equal(snapshot(a).epoch, snapshot(b).epoch);
  assert.equal(diffSnapshot(a, snapshot(b)).equal, true);
  assert.equal(diffSnapshot(b, snapshot(a)).equal, true);

  const certA = snapshot(a).certificate;
  const certB = snapshot(b).certificate;
  assert.equal(certA.valid, true);
  assert.equal(certB.valid, true);
  assert.equal(certA.digest, certB.digest);
  assert.deepEqual(verifySnapshot(snapshot(a)), { authentic: true, valid: true });
  assert.deepEqual(verifySnapshot(snapshot(b)), { authentic: true, valid: true });
});

test("stale replay of a deleted record is rejected and cannot resurrect it", () => {
  const a = emptyState("a");
  const b = emptyState("b");

  upsert(a, { id: "r1", amountA: 10, amountB: 10 });
  mergeSnapshot(b, snapshot(a));
  assert.ok(b.records.r1);

  deleteRecord(a, "r1");

  // b has not observed the tombstone and replays a stale upsert.
  upsert(b, { id: "r1", amountA: 999, amountB: 999 });

  // a merges b's snapshot while b still holds the stale record: rejected.
  assert.throws(
    () => mergeSnapshot(a, snapshot(b)),
    (err) => err instanceof ReplicaError && err.code === "stale-resurrect",
  );
  assert.equal(a.records.r1, undefined);
  assert.ok(a.tombstones.r1);

  // b merges a's snapshot: the tombstone wins over the stale update.
  mergeSnapshot(b, snapshot(a));
  assert.equal(b.records.r1, undefined);
  assert.ok(b.tombstones.r1);
  assert.equal(computeDigest(a), computeDigest(b));

  // a local upsert on a tombstoned id is rejected too.
  assert.throws(
    () => upsert(a, { id: "r1", amountA: 1, amountB: 1 }),
    (err) => err instanceof ReplicaError && err.code === "stale-resurrect",
  );
  assert.equal(a.records.r1, undefined);
});

test("concurrent resolve and delete produce a conflict and an invalid certificate", () => {
  const a = emptyState("a");
  const b = emptyState("b");

  upsert(a, { id: "r1", amountA: 10, amountB: 10 });
  mergeSnapshot(b, snapshot(a));

  resolveRecord(a, "r1");
  deleteRecord(b, "r1");

  const mergeA = mergeSnapshot(a, snapshot(b));
  const mergeB = mergeSnapshot(b, snapshot(a));

  assert.equal(mergeA.conflicts.length, 1);
  assert.equal(mergeA.conflicts[0].type, "resolve-delete");
  assert.equal(mergeA.conflicts[0].id, "r1");
  assert.deepEqual(mergeA.conflicts, mergeB.conflicts);

  // Both sides converge to the same frontier and digest.
  assert.equal(computeDigest(a), computeDigest(b));
  assert.ok(a.records.r1);
  assert.ok(a.tombstones.r1);
  assert.ok(b.records.r1);
  assert.ok(b.tombstones.r1);

  const snapA = snapshot(a);
  const snapB = snapshot(b);
  assert.equal(snapA.certificate.valid, false);
  assert.equal(snapB.certificate.valid, false);
  assert.equal(snapA.certificate.digest, snapB.certificate.digest);
  assert.deepEqual(verifySnapshot(snapA), { authentic: true, valid: false });
  assert.deepEqual(verifySnapshot(snapB), { authentic: true, valid: false });
});
