import { test } from "node:test";
import assert from "node:assert/strict";
import {
  Replica,
  ROOT,
  compareIds,
  buildFromEventLog,
  type Op,
  type InsertOp,
} from "../src/crdt.js";

test("basic insert produces visible text", () => {
  const r = new Replica("A");
  r.localInsert("h");
  r.localInsert("i");
  assert.equal(r.text(), "hi");
  assert.equal(r.size(), 2);
});

test("delete leaves a tombstone (node stays, text shrinks)", () => {
  const r = new Replica("A");
  const a = r.localInsert("a");
  r.localInsert("b");
  r.localDelete(a.id);
  assert.equal(r.text(), "b");
  assert.equal(r.size(), 2, "tombstone must remain in the tree");
});

test("concurrent inserts at same position are ordered by id (greater id first)", () => {
  // Two replicas both insert right after ROOT concurrently.
  const a = new Replica("A");
  const b = new Replica("B");
  const opA = a.localInsert("a", ROOT); // A:1
  const opB = b.localInsert("b", ROOT); // B:1
  a.apply(opB);
  b.apply(opA);
  assert.equal(a.text(), "ba", "B:1 > A:1 so b comes first");
  assert.equal(b.text(), "ba");
  assert.ok(compareIds("B:1", "A:1") > 0);
});

test("out-of-order delivery: child buffered until predecessor arrives, never re-attached to root", () => {
  const r = new Replica("R");
  const src = new Replica("S");
  const c1 = src.localInsert("x", ROOT);
  const c2 = src.localInsert("y", c1.id);
  const c3 = src.localInsert("z", c2.id);
  // Deliver in reverse order.
  r.apply(c3);
  assert.equal(r.text(), "", "grandchild must wait; must NOT attach to root");
  assert.equal(r.pendingCount(), 1);
  r.apply(c2);
  assert.equal(r.text(), "", "still waiting on c1");
  assert.equal(r.pendingCount(), 2, "c2 and its child c3 are both buffered");
  r.apply(c1);
  assert.equal(r.text(), "xyz", "buffered chain flushes in order");
  assert.equal(r.pendingCount(), 0);
});

test("delete arriving before its target insert is buffered", () => {
  const r = new Replica("R");
  const src = new Replica("S");
  const ins = src.localInsert("q", ROOT);
  const del = src.localDelete(ins.id);
  r.apply(del); // delete first
  assert.equal(r.pendingCount(), 1);
  r.apply(ins);
  assert.equal(r.text(), "", "insert arrives, then buffered delete tombstones it");
  assert.equal(r.size(), 1, "tombstone retained");
  assert.equal(r.pendingCount(), 0);
});

test("duplicate messages are idempotent", () => {
  const r = new Replica("R");
  const src = new Replica("S");
  const ins = src.localInsert("d", ROOT);
  const del = src.localDelete(ins.id);
  for (let i = 0; i < 3; i++) {
    r.apply(ins);
    r.apply(del);
  }
  assert.equal(r.text(), "");
  assert.equal(r.size(), 1, "no duplicate nodes");
});

test("self-dependency is rejected immediately", () => {
  const r = new Replica("R");
  const evil: InsertOp = { type: "insert", id: "E:1", predId: "E:1", value: "x" };
  r.apply(evil);
  assert.equal(r.text(), "");
  assert.equal(r.rejected.length, 1);
  assert.match(r.rejected[0]!.reason, /self-dependency/);
});

test("malicious dependency cycle is detected and quarantined", () => {
  const r = new Replica("R");
  // A depends on B, B depends on A: neither can ever resolve.
  const a: InsertOp = { type: "insert", id: "M:1", predId: "M:2", value: "a" };
  const b: InsertOp = { type: "insert", id: "M:2", predId: "M:1", value: "b" };
  r.apply(a);
  r.apply(b);
  assert.equal(r.text(), "", "cycle members never enter the tree");
  assert.equal(r.pendingCount(), 2, "both stuck in the buffer");
  const cyclic = r.detectCycles();
  assert.deepEqual([...cyclic].sort(), ["M:1", "M:2"]);
  assert.equal(r.pendingCount(), 0, "cycle quarantined");
  assert.equal(r.rejected.length, 2);
  // Honest traffic still works afterwards.
  const ok = new Replica("S").localInsert("z", ROOT);
  r.apply(ok);
  assert.equal(r.text(), "z");
});

test("cycle of three is detected", () => {
  const r = new Replica("R");
  r.apply({ type: "insert", id: "M:1", predId: "M:3", value: "1" });
  r.apply({ type: "insert", id: "M:2", predId: "M:1", value: "2" });
  r.apply({ type: "insert", id: "M:3", predId: "M:2", value: "3" });
  assert.deepEqual([...r.detectCycles()].sort(), ["M:1", "M:2", "M:3"]);
});

test("chain into a cycle stays buffered but is not itself cyclic", () => {
  const r = new Replica("R");
  r.apply({ type: "insert", id: "M:1", predId: "M:2", value: "1" });
  r.apply({ type: "insert", id: "M:2", predId: "M:1", value: "2" });
  r.apply({ type: "insert", id: "M:3", predId: "M:1", value: "3" }); // hangs off the cycle
  const cyclic = r.detectCycles();
  assert.deepEqual([...cyclic].sort(), ["M:1", "M:2"]);
  assert.equal(r.pendingCount(), 1, "M:3 remains buffered on quarantined M:1");
});

/** Deterministic PRNG (mulberry32) for reproducible shuffles. */
function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

test("convergence: shuffled + duplicated delivery matches full-event-log projection", () => {
  const rand = rng(42);
  // Build a script of concurrent ops across 3 replicas.
  const writers = [new Replica("A"), new Replica("B"), new Replica("C")];
  const log: Op[] = [];
  const liveIds: string[] = [];
  for (let step = 0; step < 60; step++) {
    const w = writers[Math.floor(rand() * writers.length)]!;
    if (liveIds.length > 0 && rand() < 0.3) {
      const victim = liveIds.splice(Math.floor(rand() * liveIds.length), 1)[0]!;
      log.push(w.localDelete(victim));
    } else {
      const pred =
        liveIds.length > 0 && rand() < 0.7
          ? liveIds[Math.floor(rand() * liveIds.length)]!
          : ROOT;
      const op = w.localInsert(String.fromCharCode(97 + (step % 26)), pred);
      log.push(op);
      liveIds.push(op.id);
    }
  }
  // Reference projection from the full event log.
  const reference = buildFromEventLog(log);
  assert.equal(reference.unresolved.length, 0);

  // Deliver to 5 replicas in random order, with random duplicates.
  const texts = new Set<string>();
  for (let replicaIdx = 0; replicaIdx < 5; replicaIdx++) {
    const r = new Replica(`R${replicaIdx}`);
    const shuffled = [...log];
    for (let i = shuffled.length - 1; i > 0; i--) {
      const j = Math.floor(rand() * (i + 1));
      [shuffled[i], shuffled[j]] = [shuffled[j]!, shuffled[i]!];
    }
    for (const op of shuffled) {
      r.apply(op);
      if (rand() < 0.2) r.apply(op); // random duplicate delivery
    }
    assert.equal(r.pendingCount(), 0, "all dependencies resolved");
    texts.add(r.text());
    assert.equal(r.text(), reference.text, "incremental == full-log projection");
  }
  assert.equal(texts.size, 1, "all replicas converge");
});

test("event log with a malicious cycle: reference projection excludes it too", () => {
  const honest = new Replica("H");
  const o1 = honest.localInsert("o", ROOT);
  const o2 = honest.localInsert("k", o1.id);
  const log: Op[] = [
    o2,
    { type: "insert", id: "M:1", predId: "M:2", value: "x" },
    o1,
    { type: "insert", id: "M:2", predId: "M:1", value: "y" },
  ];
  const ref = buildFromEventLog(log);
  assert.equal(ref.text, "ok");
  assert.equal(ref.unresolved.length, 2, "cycle members left unresolved");

  const r = new Replica("R");
  for (const op of log) r.apply(op);
  r.detectCycles();
  assert.equal(r.text(), ref.text);
});
