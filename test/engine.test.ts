import test from "node:test";
import assert from "node:assert/strict";
import { Change, SyncEngine } from "../src/index";

const put = (key: string, version: number, value = `${key}@${version}`): Change<string> => ({
  key,
  version,
  prev: version - 1,
  op: "put",
  value,
});
const del = (key: string, version: number): Change<string> => ({
  key,
  version,
  prev: version - 1,
  op: "delete",
});

test("in-order changes apply immediately and advance the cursor", () => {
  const engine = new SyncEngine<string>();
  assert.equal(engine.receive(put("a", 1)), "applied");
  assert.equal(engine.receive(put("a", 2)), "applied");
  assert.equal(engine.cursor("a"), 2);
  assert.deepEqual(engine.get("a"), { value: "a@2", version: 2 });
  assert.equal(engine.bufferedCount, 0);
});

test("out-of-order change is buffered, then cascades once predecessor arrives", () => {
  const engine = new SyncEngine<string>();
  assert.equal(engine.receive(put("a", 3)), "buffered");
  assert.equal(engine.receive(put("a", 2)), "buffered");
  assert.equal(engine.cursor("a"), 0);
  assert.equal(engine.get("a"), undefined);
  assert.equal(engine.bufferedCount, 2);

  assert.equal(engine.receive(put("a", 1)), "applied");
  assert.equal(engine.cursor("a"), 3);
  assert.deepEqual(engine.get("a"), { value: "a@3", version: 3 });
  assert.equal(engine.bufferedCount, 0);
});

test("delete advances the version; the chain continues after a tombstone", () => {
  const engine = new SyncEngine<string>();
  assert.equal(engine.receive(put("a", 1)), "applied");
  assert.equal(engine.receive(del("a", 2)), "applied");
  assert.equal(engine.get("a"), undefined);
  assert.equal(engine.cursor("a"), 2);

  // Out-of-order delete: buffered like any other change.
  assert.equal(engine.receive(del("b", 2)), "buffered");
  assert.equal(engine.receive(put("b", 1)), "applied");
  assert.equal(engine.cursor("b"), 2);
  assert.equal(engine.get("b"), undefined);

  // Re-creation after delete chains on the tombstone version.
  assert.equal(engine.receive(put("a", 3)), "applied");
  assert.deepEqual(engine.get("a"), { value: "a@3", version: 3 });
});

test("missing predecessor is never guessed: gaps block the whole chain", () => {
  const engine = new SyncEngine<string>();
  assert.equal(engine.receive(put("a", 3)), "buffered");
  // v2 waits on v1 which never arrived: v3 must NOT be applied by skipping.
  assert.equal(engine.receive(put("a", 2)), "buffered");
  assert.equal(engine.cursor("a"), 0);
  assert.equal(engine.get("a"), undefined);

  assert.equal(engine.receive(put("a", 1)), "applied");
  assert.equal(engine.cursor("a"), 3);
});

test("full budget yields backpressure and rejects; draining frees budget", () => {
  const engine = new SyncEngine<string>({ maxBuffered: 2 });
  assert.equal(engine.receive(put("a", 2)), "buffered");
  assert.equal(engine.receive(put("a", 3)), "buffered");
  assert.equal(engine.budgetRemaining, 0);

  // Budget full: change is rejected, not stored.
  assert.equal(engine.receive(put("a", 4)), "backpressure");
  assert.equal(engine.bufferedCount, 2);

  // Missing predecessor drains the buffer and frees budget.
  assert.equal(engine.receive(put("a", 1)), "applied");
  assert.equal(engine.bufferedCount, 0);
  assert.equal(engine.cursor("a"), 3);

  // The previously rejected change can now be retried successfully.
  assert.equal(engine.receive(put("a", 4)), "applied");
  assert.equal(engine.cursor("a"), 4);
});

test("stale, duplicate and invalid changes are rejected without side effects", () => {
  const engine = new SyncEngine<string>();
  engine.receive(put("a", 1));
  engine.receive(put("a", 2));

  assert.equal(engine.receive(put("a", 2)), "stale");
  assert.equal(engine.receive(put("a", 1)), "stale");

  assert.equal(engine.receive(put("a", 4)), "buffered");
  assert.equal(engine.receive(put("a", 4)), "duplicate");

  assert.equal(engine.receive({ key: "a", version: 5, prev: 5, op: "put" }), "invalid");
  assert.equal(engine.receive({ key: "a", version: 0, prev: 0, op: "put" }), "invalid");
  // prev already applied but this version was not: contradictory history.
  assert.equal(engine.receive({ key: "a", version: 6, prev: 1, op: "put" }), "invalid");

  assert.equal(engine.cursor("a"), 2);
  assert.equal(engine.bufferedCount, 1);
});

test("snapshot preserves pending changes; restore resumes seamlessly", () => {
  const engine = new SyncEngine<string>();
  engine.receive(put("a", 1));
  engine.receive(put("a", 3)); // buffered, waiting on v2
  engine.receive(del("b", 2)); // buffered tombstone, waiting on b@v1

  const snap = engine.snapshot();
  assert.equal(snap.pending.length, 2);

  // Snapshot is plain data: survives JSON round-trip.
  const restored = SyncEngine.restore<string>(JSON.parse(JSON.stringify(snap)));
  assert.equal(restored.bufferedCount, 2);
  assert.equal(restored.cursor("a"), 1);
  assert.deepEqual(restored.get("a"), { value: "a@1", version: 1 });

  // Delivering missing predecessors on the restored engine cascades both chains.
  assert.equal(restored.receive(put("a", 2)), "applied");
  assert.equal(restored.cursor("a"), 3);
  assert.equal(restored.receive(put("b", 1)), "applied");
  assert.equal(restored.cursor("b"), 2);
  assert.equal(restored.get("b"), undefined);
  assert.equal(restored.bufferedCount, 0);
});

test("restore preserves pending even when budget override is smaller", () => {
  const engine = new SyncEngine<string>({ maxBuffered: 4 });
  engine.receive(put("a", 2));
  engine.receive(put("a", 3));
  const restored = SyncEngine.restore<string>(engine.snapshot(), { maxBuffered: 1 });
  assert.equal(restored.bufferedCount, 2);
  // Budget gates only NEW receives.
  assert.equal(restored.receive(put("c", 5)), "backpressure");
  assert.equal(restored.receive(put("a", 1)), "applied");
  assert.equal(restored.cursor("a"), 3);
});

test("restore rejects unknown snapshot formats", () => {
  const engine = new SyncEngine<string>();
  const snap = { ...engine.snapshot(), formatVersion: 2 } as never;
  assert.throws(() => SyncEngine.restore<string>(snap));
});
