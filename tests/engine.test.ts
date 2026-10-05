import { test } from "node:test";
import assert from "node:assert/strict";
import { TransferEngine } from "../src/engine.ts";
import type { SimEvent } from "../src/events.ts";

function setup(granted = true): TransferEngine {
  const engine = new TransferEngine();
  if (granted) {
    engine.dispatch({ kind: "grant", tick: 0, seq: 0, principal: "alice", objectId: "obj1" });
  }
  return engine;
}

function begin(engine: TransferEngine, tick: number, totalChunks = 3): void {
  engine.dispatch({
    kind: "begin", tick, seq: 0,
    transferId: "tx1", principal: "alice", objectId: "obj1", totalChunks,
  });
}

test("batch binds the permission version at submit time", () => {
  const engine = setup();
  begin(engine, 1);
  const ev = engine.dispatch({
    kind: "submitBatch", tick: 2, seq: 0, transferId: "tx1", batchId: "b1", chunks: [0, 1],
  });
  assert.equal(ev.decision, "accepted");
  assert.equal(ev.rule, "BATCH_CACHED");
  assert.equal(ev.boundVersion, 1, "bound to ledger version after one grant");
  assert.equal(ev.permissionVersion, 1);
});

test("revoke after caching blocks commit of cached chunks", () => {
  const engine = setup();
  begin(engine, 1);
  engine.dispatch({ kind: "submitBatch", tick: 2, seq: 0, transferId: "tx1", batchId: "b1", chunks: [0, 1] });
  engine.dispatch({ kind: "revoke", tick: 3, seq: 0, principal: "alice", objectId: "obj1" });
  const ev = engine.dispatch({ kind: "commitBatch", tick: 4, seq: 0, transferId: "tx1", batchId: "b1" });
  assert.equal(ev.decision, "rejected");
  assert.equal(ev.rule, "PERMISSION_REVOKED");
  assert.equal(ev.boundVersion, 1);
  assert.equal(ev.permissionVersion, 2);
  assert.equal(engine.getTransfer("tx1")!.committed.size, 0);
});

test("revoke then re-grant still blocks cached batch as stale", () => {
  const engine = setup();
  begin(engine, 1);
  engine.dispatch({ kind: "submitBatch", tick: 2, seq: 0, transferId: "tx1", batchId: "b1", chunks: [0] });
  engine.dispatch({ kind: "revoke", tick: 3, seq: 0, principal: "alice", objectId: "obj1" });
  engine.dispatch({ kind: "grant", tick: 4, seq: 0, principal: "alice", objectId: "obj1" });
  const ev = engine.dispatch({ kind: "commitBatch", tick: 5, seq: 0, transferId: "tx1", batchId: "b1" });
  assert.equal(ev.decision, "rejected");
  assert.equal(ev.rule, "STALE_VERSION");
  assert.equal(ev.boundVersion, 1);
  assert.equal(ev.permissionVersion, 3);
});

test("resume re-checks permission and fails while revoked", () => {
  const engine = setup();
  begin(engine, 1);
  engine.dispatch({ kind: "pause", tick: 2, seq: 0, transferId: "tx1" });
  engine.dispatch({ kind: "revoke", tick: 3, seq: 0, principal: "alice", objectId: "obj1" });
  const ev = engine.dispatch({ kind: "resume", tick: 4, seq: 0, transferId: "tx1" });
  assert.equal(ev.decision, "rejected");
  assert.equal(ev.rule, "RESUME_PERMISSION_REVOKED");
  assert.equal(engine.getTransfer("tx1")!.status, "paused");
});

test("resume succeeds after re-grant but pre-pause batches go stale", () => {
  const engine = setup();
  begin(engine, 1);
  engine.dispatch({ kind: "submitBatch", tick: 2, seq: 0, transferId: "tx1", batchId: "b1", chunks: [0] });
  engine.dispatch({ kind: "pause", tick: 3, seq: 0, transferId: "tx1" });
  engine.dispatch({ kind: "revoke", tick: 4, seq: 0, principal: "alice", objectId: "obj1" });
  engine.dispatch({ kind: "grant", tick: 5, seq: 0, principal: "alice", objectId: "obj1" });
  const resume = engine.dispatch({ kind: "resume", tick: 6, seq: 0, transferId: "tx1" });
  assert.equal(resume.decision, "accepted");
  assert.equal(resume.rule, "RESUME_RECHECKED");
  assert.match(resume.detail, /drifted/);
  const commit = engine.dispatch({ kind: "commitBatch", tick: 7, seq: 0, transferId: "tx1", batchId: "b1" });
  assert.equal(commit.rule, "STALE_VERSION");
  // Fresh batch bound to the new version commits fine.
  engine.dispatch({ kind: "submitBatch", tick: 8, seq: 0, transferId: "tx1", batchId: "b2", chunks: [0] });
  const commit2 = engine.dispatch({ kind: "commitBatch", tick: 9, seq: 0, transferId: "tx1", batchId: "b2" });
  assert.equal(commit2.decision, "accepted");
});

test("same tick: revoke before commit rejects, commit before revoke accepts", () => {
  // revoke first (seq 0), commit second (seq 1) -> rejected
  const a = setup();
  begin(a, 1);
  a.dispatch({ kind: "submitBatch", tick: 2, seq: 0, transferId: "tx1", batchId: "b1", chunks: [0] });
  a.dispatch({ kind: "revoke", tick: 3, seq: 0, principal: "alice", objectId: "obj1" });
  const evA = a.dispatch({ kind: "commitBatch", tick: 3, seq: 1, transferId: "tx1", batchId: "b1" });
  assert.equal(evA.decision, "rejected");
  assert.equal(evA.rule, "PERMISSION_REVOKED");

  // commit first (seq 0), revoke second (seq 1) -> accepted
  const b = setup();
  begin(b, 1);
  b.dispatch({ kind: "submitBatch", tick: 2, seq: 0, transferId: "tx1", batchId: "b1", chunks: [0] });
  const evB = b.dispatch({ kind: "commitBatch", tick: 3, seq: 0, transferId: "tx1", batchId: "b1" });
  b.dispatch({ kind: "revoke", tick: 3, seq: 1, principal: "alice", objectId: "obj1" });
  assert.equal(evB.decision, "accepted");
  assert.equal(evB.rule, "BATCH_COMMITTED");
});

test("out-of-order dispatch is refused", () => {
  const engine = setup(); // last event is t0#0
  assert.throws(
    () => engine.dispatch({ kind: "grant", tick: 0, seq: 0, principal: "bob", objectId: "obj1" }),
    /out-of-order/,
  );
  assert.throws(
    () => engine.dispatch({ kind: "grant", tick: 0, seq: 0, principal: "carol", objectId: "obj1" }),
    /out-of-order/,
  );
});

test("published objects retain history across revocation", () => {
  const engine = setup();
  engine.dispatch({ kind: "publish", tick: 1, seq: 0, principal: "alice", objectId: "obj1", payload: "v1-body" });
  engine.dispatch({ kind: "publish", tick: 2, seq: 0, principal: "alice", objectId: "obj1", payload: "v2-body" });
  engine.dispatch({ kind: "revoke", tick: 3, seq: 0, principal: "alice", objectId: "obj1" });
  const denied = engine.dispatch({ kind: "publish", tick: 4, seq: 0, principal: "alice", objectId: "obj1", payload: "v3-body" });
  assert.equal(denied.rule, "PUBLISH_NO_PERMISSION");

  const history = engine.getHistory("obj1");
  assert.equal(history.length, 2);
  assert.deepEqual(history.map((v) => v.version), [1, 2]);
  assert.deepEqual(history.map((v) => v.payload), ["v1-body", "v2-body"]);
});

test("commit completes the transfer when all chunks land", () => {
  const engine = setup();
  begin(engine, 1, 2);
  engine.dispatch({ kind: "submitBatch", tick: 2, seq: 0, transferId: "tx1", batchId: "b1", chunks: [0, 1] });
  const ev = engine.dispatch({ kind: "commitBatch", tick: 3, seq: 0, transferId: "tx1", batchId: "b1" });
  assert.equal(ev.decision, "accepted");
  assert.match(ev.detail, /completed/);
  assert.equal(engine.getTransfer("tx1")!.status, "completed");
});

test("begin without permission is rejected", () => {
  const engine = setup(false);
  const ev = engine.dispatch({
    kind: "begin", tick: 1, seq: 0,
    transferId: "tx1", principal: "alice", objectId: "obj1", totalChunks: 1,
  });
  assert.equal(ev.decision, "rejected");
  assert.equal(ev.rule, "BEGIN_NO_PERMISSION");
});

test("runAll sorts events into (tick, seq) order", () => {
  const engine = new TransferEngine();
  const events: SimEvent[] = [
    { kind: "commitBatch", tick: 3, seq: 0, transferId: "tx1", batchId: "b1" },
    { kind: "begin", tick: 1, seq: 0, transferId: "tx1", principal: "alice", objectId: "obj1", totalChunks: 1 },
    { kind: "grant", tick: 0, seq: 0, principal: "alice", objectId: "obj1" },
    { kind: "submitBatch", tick: 2, seq: 0, transferId: "tx1", batchId: "b1", chunks: [0] },
  ];
  const evidence = engine.runAll(events);
  assert.deepEqual(evidence.map((e) => e.rule),
    ["GRANT_APPLIED", "TRANSFER_BEGUN", "BATCH_CACHED", "BATCH_COMMITTED"]);
});
