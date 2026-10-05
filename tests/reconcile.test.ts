import { test } from "node:test";
import assert from "node:assert/strict";
import type { SimEvent } from "../src/events.ts";
import { reconcile } from "../src/reconcile.ts";
import { TransferEngine } from "../src/engine.ts";
import { formatEvidence } from "../src/evidence.ts";

const scripted: SimEvent[] = [
  { kind: "grant", tick: 0, seq: 0, principal: "alice", objectId: "obj1" },
  { kind: "begin", tick: 1, seq: 0, transferId: "tx1", principal: "alice", objectId: "obj1", totalChunks: 4 },
  { kind: "submitBatch", tick: 2, seq: 0, transferId: "tx1", batchId: "b1", chunks: [0, 1] },
  { kind: "commitBatch", tick: 2, seq: 1, transferId: "tx1", batchId: "b1" },
  { kind: "submitBatch", tick: 3, seq: 0, transferId: "tx1", batchId: "b2", chunks: [2, 3] },
  { kind: "pause", tick: 4, seq: 0, transferId: "tx1" },
  { kind: "revoke", tick: 5, seq: 0, principal: "alice", objectId: "obj1" },
  { kind: "resume", tick: 6, seq: 0, transferId: "tx1" },
  { kind: "commitBatch", tick: 6, seq: 1, transferId: "tx1", batchId: "b2" },
  { kind: "grant", tick: 7, seq: 0, principal: "alice", objectId: "obj1" },
  { kind: "resume", tick: 8, seq: 0, transferId: "tx1" },
  { kind: "commitBatch", tick: 9, seq: 0, transferId: "tx1", batchId: "b2" },
  { kind: "submitBatch", tick: 10, seq: 0, transferId: "tx1", batchId: "b3", chunks: [2, 3] },
  { kind: "commitBatch", tick: 10, seq: 1, transferId: "tx1", batchId: "b3" },
  { kind: "publish", tick: 11, seq: 0, principal: "alice", objectId: "obj1", payload: "release-1" },
  { kind: "revoke", tick: 12, seq: 0, principal: "alice", objectId: "obj1" },
  { kind: "publish", tick: 13, seq: 0, principal: "alice", objectId: "obj1", payload: "release-2" },
];

test("scripted scenario reconciles with the event model", () => {
  const report = reconcile(scripted);
  assert.deepEqual(report.mismatches, []);
  assert.ok(report.ok);
});

test("scripted scenario produces the expected evidence trail", () => {
  const engine = new TransferEngine();
  const evidence = engine.runAll(scripted);
  const rules = evidence.map((e) => e.rule);
  assert.deepEqual(rules, [
    "GRANT_APPLIED",
    "TRANSFER_BEGUN",
    "BATCH_CACHED",
    "BATCH_COMMITTED",
    "BATCH_CACHED",
    "TRANSFER_PAUSED",
    "REVOKE_APPLIED",
    "RESUME_PERMISSION_REVOKED", // resume re-check fails while revoked
    "TRANSFER_NOT_ACTIVE",       // cached chunks cannot commit while paused
    "GRANT_APPLIED",
    "RESUME_RECHECKED",          // re-check passes after re-grant
    "STALE_VERSION",             // b2 was bound to the pre-revoke version
    "BATCH_CACHED",
    "BATCH_COMMITTED",           // transfer completes
    "PUBLISHED",
    "REVOKE_APPLIED",
    "PUBLISH_NO_PERMISSION",
  ]);
  // Published history survives the final revocation.
  const history = engine.getHistory("obj1");
  assert.deepEqual(history.map((v) => v.payload), ["release-1"]);
  assert.equal(engine.getTransfer("tx1")!.status, "completed");
});

/** Deterministic PRNG (LCG) so fuzz runs are reproducible. */
function makeRng(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 0x100000000;
  };
}

function fuzzEvents(seed: number, count: number): SimEvent[] {
  const rng = makeRng(seed);
  const pick = <T>(items: readonly T[]): T => items[Math.floor(rng() * items.length)]!;
  const principals = ["alice", "bob"];
  const objects = ["obj1", "obj2"];
  const transfers = ["tx1", "tx2"];
  const batches = ["b1", "b2", "b3"];
  const events: SimEvent[] = [];
  for (let i = 0; i < count; i++) {
    const tick = Math.floor(i / 3);
    const seq = i % 3;
    const kind = Math.floor(rng() * 8);
    switch (kind) {
      case 0:
        events.push({ kind: "grant", tick, seq, principal: pick(principals), objectId: pick(objects) });
        break;
      case 1:
        events.push({ kind: "revoke", tick, seq, principal: pick(principals), objectId: pick(objects) });
        break;
      case 2:
        events.push({
          kind: "begin", tick, seq,
          transferId: pick(transfers), principal: pick(principals),
          objectId: pick(objects), totalChunks: 1 + Math.floor(rng() * 4),
        });
        break;
      case 3:
        events.push({
          kind: "submitBatch", tick, seq,
          transferId: pick(transfers), batchId: pick(batches),
          chunks: [Math.floor(rng() * 4), Math.floor(rng() * 4)],
        });
        break;
      case 4:
        events.push({ kind: "pause", tick, seq, transferId: pick(transfers) });
        break;
      case 5:
        events.push({ kind: "resume", tick, seq, transferId: pick(transfers) });
        break;
      case 6:
        events.push({ kind: "commitBatch", tick, seq, transferId: pick(transfers), batchId: pick(batches) });
        break;
      default:
        events.push({
          kind: "publish", tick, seq,
          principal: pick(principals), objectId: pick(objects),
          payload: `p${i}`,
        });
        break;
    }
  }
  return events;
}

test("fuzzed event streams reconcile with the event model", () => {
  for (let seed = 1; seed <= 25; seed++) {
    const events = fuzzEvents(seed, 240);
    const report = reconcile(events);
    assert.ok(
      report.ok,
      `seed ${seed} mismatches:\n${report.mismatches.slice(0, 5).join("\n")}`,
    );
  }
});

test("engine is deterministic: identical streams give identical evidence", () => {
  const events = fuzzEvents(99, 240);
  const run = () => new TransferEngine().runAll(events).map(formatEvidence);
  assert.deepEqual(run(), run());
});
