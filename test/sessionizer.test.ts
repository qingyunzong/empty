import { test } from "node:test";
import assert from "node:assert/strict";
import {
  Operation,
  Session,
  SessionDiff,
  SessionStore,
  sessionKey,
} from "../src/sessionizer";

const GAP = 30_000; // 30s

function ev(id: number, userId: string, ts: number) {
  return { id, userId, ts };
}

function applyDiff(sessions: Session[], diff: SessionDiff): Session[] {
  const bag = new Map<string, { s: Session; n: number }>();
  const put = (s: Session, d: number) => {
    const k = sessionKey(s);
    const e = bag.get(k) ?? { s, n: 0 };
    e.n += d;
    bag.set(k, e);
  };
  for (const s of sessions) put(s, 1);
  for (const s of diff.removed) put(s, -1);
  for (const s of diff.added) put(s, 1);
  return [...bag.values()].filter((e) => e.n > 0).map((e) => e.s);
}

function keysOf(sessions: Session[]): string[] {
  return sessions.map(sessionKey).sort();
}

test("groups events with adjacent gap <= gapMs; boundary is inclusive", () => {
  const store = new SessionStore(GAP);
  store.apply([
    { type: "insert", event: ev(1, "u1", 0) },
    { type: "insert", event: ev(2, "u1", GAP) }, // exactly GAP -> same session
    { type: "insert", event: ev(3, "u1", GAP + 1 + GAP) }, // gap of GAP+1 -> split
  ]);
  const sessions = store.sessions();
  assert.equal(sessions.length, 2);
  assert.deepEqual(sessions[0]!.eventIds, [1, 2]);
  assert.deepEqual(sessions[1]!.eventIds, [3]);
});

test("session ID is the minimum member event ID", () => {
  const store = new SessionStore(GAP);
  store.apply([
    { type: "insert", event: ev(9, "u1", 0) },
    { type: "insert", event: ev(4, "u1", 10) },
    { type: "insert", event: ev(7, "u1", 20) },
  ]);
  assert.equal(store.sessions()[0]!.id, 4);
});

test("out-of-order inserts match in-order result", () => {
  const a = new SessionStore(GAP);
  for (const e of [ev(1, "u1", 0), ev(2, "u1", 10), ev(3, "u1", 20)]) a.insert(e);
  const b = new SessionStore(GAP);
  for (const e of [ev(3, "u1", 20), ev(1, "u1", 0), ev(2, "u1", 10)]) b.insert(e);
  assert.deepEqual(keysOf(b.sessions()), keysOf(a.sessions()));
});

test("inserting a middle event merges two sessions into one", () => {
  const store = new SessionStore(GAP);
  store.apply([
    { type: "insert", event: ev(1, "u1", 0) },
    { type: "insert", event: ev(3, "u1", 2 * GAP) },
  ]);
  assert.equal(store.sessions().length, 2);
  const diff = store.insert(ev(2, "u1", GAP)); // bridges the gap
  assert.equal(diff.removed.length, 2);
  assert.equal(diff.added.length, 1);
  assert.deepEqual(diff.added[0]!.eventIds, [1, 2, 3]);
  assert.equal(diff.added[0]!.id, 1);
  assert.deepEqual(store.sessions(), diff.added);
});

test("deleting a middle event splits one session into two", () => {
  const store = new SessionStore(GAP);
  store.apply([
    { type: "insert", event: ev(1, "u1", 0) },
    { type: "insert", event: ev(2, "u1", GAP) },
    { type: "insert", event: ev(3, "u1", 2 * GAP) },
  ]);
  const diff = store.delete(2);
  assert.equal(diff.removed.length, 1);
  assert.deepEqual(diff.removed[0]!.eventIds, [1, 2, 3]);
  assert.equal(diff.added.length, 2);
  assert.deepEqual(diff.added[0]!.eventIds, [1]);
  assert.deepEqual(diff.added[1]!.eventIds, [3]);
});

test("correcting an event time (upsert) can merge sessions", () => {
  const store = new SessionStore(GAP);
  store.apply([
    { type: "insert", event: ev(1, "u1", 0) },
    { type: "insert", event: ev(2, "u1", 10 * GAP) }, // far away: own session
    { type: "insert", event: ev(3, "u1", GAP) },
  ]);
  assert.equal(store.sessions().length, 2);
  // Time correction: event 2 actually happened between 1 and 3.
  const diff = store.insert(ev(2, "u1", GAP / 2));
  assert.equal(diff.removed.length, 2);
  assert.equal(diff.added.length, 1);
  assert.deepEqual(diff.added[0]!.eventIds, [1, 2, 3]);
  assert.equal(store.sessions().length, 1);
});

test("deleting a nonexistent event is a no-op with an empty diff", () => {
  const store = new SessionStore(GAP);
  store.insert(ev(1, "u1", 0));
  const diff = store.delete(999);
  assert.deepEqual(diff, { added: [], removed: [] });
  assert.equal(store.size(), 1);
});

test("net diff cancels transient changes within one batch", () => {
  const store = new SessionStore(GAP);
  store.apply([
    { type: "insert", event: ev(1, "u1", 0) },
    { type: "insert", event: ev(2, "u1", 10) },
  ]);
  const before = store.sessions();
  // Delete then re-insert the same event inside a single batch.
  const diff = store.apply([
    { type: "delete", id: 2 },
    { type: "insert", event: ev(2, "u1", 10) },
  ]);
  assert.deepEqual(diff, { added: [], removed: [] });
  assert.deepEqual(keysOf(store.sessions()), keysOf(before));
});

test("deleting all events of a user removes every session", () => {
  const store = new SessionStore(GAP);
  store.apply([
    { type: "insert", event: ev(1, "u1", 0) },
    { type: "insert", event: ev(2, "u1", 10 * GAP) },
  ]);
  const diff = store.apply([
    { type: "delete", id: 1 },
    { type: "delete", id: 2 },
  ]);
  assert.equal(diff.removed.length, 2);
  assert.equal(diff.added.length, 0);
  assert.deepEqual(store.sessions(), []);
});

// Seeded PRNG (mulberry32) for a reproducible fuzz run.
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

test("fuzz: random out-of-order batches; net diff and rebuild always agree", () => {
  const rand = mulberry32(20261005);
  const store = new SessionStore(GAP);
  const users = ["u1", "u2", "u3"];
  const live = new Set<number>();
  let nextId = 1;

  for (let round = 0; round < 500; round++) {
    const before = store.sessions();
    const ops: Operation[] = [];
    const opCount = 1 + Math.floor(rand() * 6);
    for (let i = 0; i < opCount; i++) {
      const r = rand();
      if (r < 0.45 || live.size === 0) {
        // Out-of-order insert: timestamps are NOT monotonic in ID.
        const id = nextId++;
        const userId = users[Math.floor(rand() * users.length)]!;
        const ts = Math.floor(rand() * 200) * 10_000;
        ops.push({ type: "insert", event: ev(id, userId, ts) });
        live.add(id);
      } else if (r < 0.75) {
        const ids = [...live];
        const id = ids[Math.floor(rand() * ids.length)]!;
        ops.push({ type: "delete", id });
        live.delete(id);
      } else {
        // Time correction via upsert of an existing ID.
        const ids = [...live];
        const id = ids[Math.floor(rand() * ids.length)]!;
        const userId = users[Math.floor(rand() * users.length)]!;
        const ts = Math.floor(rand() * 200) * 10_000;
        ops.push({ type: "insert", event: ev(id, userId, ts) });
      }
    }

    const diff = store.apply(ops);
    const after = store.sessions();

    // 1. Net diff consistency: before - removed + added == after.
    assert.deepEqual(
      keysOf(applyDiff(before, diff)),
      keysOf(after),
      `diff mismatch at round ${round}`,
    );

    // 2. Incremental state equals an independent sorted rebuild.
    assert.deepEqual(after, store.rebuild(), `rebuild mismatch at round ${round}`);

    // 3. Session invariant: ID is always the minimum member ID.
    for (const s of after) {
      const min = s.eventIds.reduce((a, b) => {
        const na = typeof a === "number" ? a : Number(a);
        const nb = typeof b === "number" ? b : Number(b);
        return na <= nb ? a : b;
      });
      assert.equal(s.id, min);
    }
  }
});
