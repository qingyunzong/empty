import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  Change,
  INITIAL_VERSION,
  Snapshot,
  SyncStore,
} from "../src/sync.js";

type Value = { data: string };

function put(objectId: string, base: number, version: number, data: string): Change<Value> {
  return { objectId, base, version, op: "put", value: { data } };
}

function del(objectId: string, base: number, version: number): Change<Value> {
  return { objectId, base, version, op: "delete" };
}

describe("in-order application", () => {
  it("applies changes whose prerequisite is the current cursor", () => {
    const store = new SyncStore<Value>();
    assert.equal(store.receive(put("a", 0, 1, "one")).status, "applied");
    assert.equal(store.receive(put("a", 1, 2, "two")).status, "applied");
    assert.deepEqual(store.get("a"), { data: "two" });
    assert.equal(store.cursorOf("a"), 2);
  });

  it("tracks objects independently", () => {
    const store = new SyncStore<Value>();
    store.receive(put("a", 0, 1, "a1"));
    store.receive(put("b", 0, 1, "b1"));
    assert.equal(store.cursorOf("a"), 1);
    assert.equal(store.cursorOf("b"), 1);
    assert.equal(store.cursorOf("never-seen"), INITIAL_VERSION);
  });
});

describe("out-of-order buffering", () => {
  it("buffers a change until its prerequisite arrives, then drains in order", () => {
    const store = new SyncStore<Value>();
    assert.equal(store.receive(put("a", 2, 3, "three")).status, "buffered");
    assert.equal(store.receive(put("a", 1, 2, "two")).status, "buffered");
    assert.equal(store.pendingCount(), 2);
    assert.equal(store.get("a"), undefined);
    const result = store.receive(put("a", 0, 1, "one"));
    assert.equal(result.status, "applied");
    assert.equal(result.cursor, 3);
    assert.equal(store.pendingCount(), 0);
    assert.deepEqual(store.get("a"), { data: "three" });
  });

  it("never guesses when the prerequisite is missing", () => {
    const store = new SyncStore<Value>();
    store.receive(put("a", 0, 1, "one"));
    // Base 5 was never applied; the change must wait, not be forced in.
    assert.equal(store.receive(put("a", 5, 6, "six")).status, "buffered");
    assert.equal(store.cursorOf("a"), 1);
    assert.deepEqual(store.get("a"), { data: "one" });
  });

  it("ignores duplicates of applied and of already-buffered changes", () => {
    const store = new SyncStore<Value>();
    store.receive(put("a", 0, 1, "one"));
    assert.equal(store.receive(put("a", 0, 1, "one")).status, "duplicate");
    assert.equal(store.receive(put("a", 2, 3, "three")).status, "buffered");
    assert.equal(store.receive(put("a", 2, 3, "three")).status, "duplicate");
    assert.equal(store.pendingCount(), 1);
  });
});

describe("deletes", () => {
  it("advance the cursor like any other change", () => {
    const store = new SyncStore<Value>();
    store.receive(put("a", 0, 1, "one"));
    assert.equal(store.receive(del("a", 1, 2)).status, "applied");
    assert.equal(store.cursorOf("a"), 2);
    assert.equal(store.has("a"), false);
    assert.equal(store.get("a"), undefined);
  });

  it("allow resurrection only on top of the delete's version", () => {
    const store = new SyncStore<Value>();
    store.receive(put("a", 0, 1, "one"));
    store.receive(del("a", 1, 2));
    // Based on the pre-delete version: must not apply.
    assert.equal(store.receive(put("a", 1, 3, "stale")).status, "buffered");
    // Based on the delete's version: applies.
    assert.equal(store.receive(put("a", 2, 3, "back")).status, "applied");
    assert.deepEqual(store.get("a"), { data: "back" });
    assert.equal(store.cursorOf("a"), 3);
  });

  it("treats pre-delete changes as duplicates after the delete", () => {
    const store = new SyncStore<Value>();
    store.receive(put("a", 0, 1, "one"));
    store.receive(del("a", 1, 2));
    assert.equal(store.receive(put("a", 0, 1, "one")).status, "duplicate");
  });
});

describe("backpressure", () => {
  it("rejects out-of-order changes when the budget is full", () => {
    const store = new SyncStore<Value>({ pendingBudget: 2 });
    assert.equal(store.receive(put("a", 1, 2, "two")).status, "buffered");
    assert.equal(store.receive(put("a", 2, 3, "three")).status, "buffered");
    const rejected = store.receive(put("a", 3, 4, "four"));
    assert.equal(rejected.status, "backpressure");
    assert.equal(rejected.pending, 2);
  });

  it("still applies in-order changes while the buffer is full", () => {
    const store = new SyncStore<Value>({ pendingBudget: 1 });
    store.receive(put("a", 2, 3, "three")); // buffered; buffer now full
    // In-order changes never consume budget, even when it is full.
    const result = store.receive(put("a", 0, 1, "one"));
    assert.equal(result.status, "applied");
    assert.equal(store.pendingCount(), 1); // still waiting on version 2
    assert.equal(store.cursorOf("a"), 1);
    // The missing link applies and drains the buffered change.
    assert.equal(store.receive(put("a", 1, 2, "two")).status, "applied");
    assert.equal(store.cursorOf("a"), 3);
    assert.equal(store.pendingCount(), 0);
    // Headroom is back; out-of-order changes are accepted again.
    assert.equal(store.receive(put("a", 4, 5, "five")).status, "buffered");
  });

  it("supports a zero budget that buffers nothing", () => {
    const store = new SyncStore<Value>({ pendingBudget: 0 });
    assert.equal(store.receive(put("a", 1, 2, "two")).status, "backpressure");
    assert.equal(store.receive(put("a", 0, 1, "one")).status, "applied");
  });
});

describe("snapshot recovery", () => {
  it("preserves applied state, cursors and pending changes", () => {
    const store = new SyncStore<Value>();
    store.receive(put("a", 0, 1, "one"));
    store.receive(put("a", 2, 3, "three")); // pending: gap at base 1
    store.receive(put("b", 0, 1, "b1"));
    store.receive(del("b", 1, 2)); // deleted: cursor must survive
    const restored = SyncStore.restore<Value>(store.snapshot());
    assert.deepEqual(restored.get("a"), { data: "one" });
    assert.equal(restored.cursorOf("a"), 1);
    assert.equal(restored.cursorOf("b"), 2);
    assert.equal(restored.has("b"), false);
    assert.equal(restored.pendingCount(), 1);
    // The pending change applies once its prerequisite arrives post-restore.
    assert.equal(restored.receive(put("a", 1, 2, "two")).status, "applied");
    assert.equal(restored.cursorOf("a"), 3);
    assert.deepEqual(restored.get("a"), { data: "three" });
    // Resurrection on top of the restored delete cursor still works.
    assert.equal(restored.receive(put("b", 2, 3, "b-back")).status, "applied");
  });

  it("survives a JSON round trip", () => {
    const store = new SyncStore<Value>();
    store.receive(put("a", 0, 1, "one"));
    store.receive(put("a", 2, 3, "three")); // pending: gap at base 1
    const wire = JSON.parse(JSON.stringify(store.snapshot())) as Snapshot<Value>;
    const restored = SyncStore.restore<Value>(wire);
    assert.equal(restored.pendingCount(), 1);
    assert.equal(restored.receive(put("a", 1, 2, "two")).status, "applied");
    assert.equal(restored.cursorOf("a"), 3);
    assert.deepEqual(restored.get("a"), { data: "three" });
  });

  it("rejects unknown snapshot formats", () => {
    const bogus = { format: 99, objects: {}, pending: [] } as unknown as Snapshot<Value>;
    assert.throws(() => SyncStore.restore<Value>(bogus), /format/);
  });
});

/** Deterministic PRNG (mulberry32) so failures reproduce. */
function rng(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function shuffle<T>(items: T[], random: () => number): T[] {
  const copy = [...items];
  for (let i = copy.length - 1; i > 0; i -= 1) {
    const j = Math.floor(random() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy;
}

/** Reference model: changes applied strictly in version order. */
function referenceApply(log: Change<Value>[]): Map<string, { cursor: number; value?: Value }> {
  const model = new Map<string, { cursor: number; value?: Value }>();
  for (const change of log) {
    const current = model.get(change.objectId)?.cursor ?? INITIAL_VERSION;
    assert.equal(change.base, current, "reference log must be a valid chain");
    const next: { cursor: number; value?: Value } = { cursor: change.version };
    if (change.op === "put" && change.value !== undefined) next.value = change.value;
    model.set(change.objectId, next);
  }
  return model;
}

/** Build a random but internally consistent per-object version chain. */
function generateLog(random: () => number, objects: number, steps: number): Change<Value>[] {
  const cursors = new Map<string, number>();
  const live = new Set<string>();
  const log: Change<Value>[] = [];
  for (let step = 0; step < steps; step += 1) {
    const id = `obj-${Math.floor(random() * objects)}`;
    const base = cursors.get(id) ?? INITIAL_VERSION;
    const version = base + 1;
    const canDelete = live.has(id);
    const doDelete = canDelete && random() < 0.25;
    if (doDelete) {
      log.push(del(id, base, version));
      live.delete(id);
    } else {
      log.push(put(id, base, version, `v${version}`));
      live.add(id);
    }
    cursors.set(id, version);
  }
  return log;
}

describe("shuffled delivery matches the sequential reference", () => {
  for (const seed of [1, 7, 42, 1337, 20261006]) {
    it(`converges to the reference state (seed ${seed})`, () => {
      const random = rng(seed);
      const log = generateLog(random, 6, 400);
      const reference = referenceApply(log);
      const store = new SyncStore<Value>({ pendingBudget: 64 });
      const queue = shuffle(log, random);
      // At-least-once delivery with retries: backpressure means "try later".
      let guard = 0;
      while (queue.length > 0) {
        assert.ok(guard < 1_000_000, "delivery made no progress");
        guard += 1;
        const change = queue.shift() as Change<Value>;
        const { status } = store.receive(change);
        if (status === "backpressure") queue.push(change);
      }
      assert.equal(store.pendingCount(), 0);
      for (const [id, expected] of reference) {
        assert.equal(store.cursorOf(id), expected.cursor, `cursor of ${id}`);
        if (expected.value === undefined) {
          assert.equal(store.has(id), false, `${id} must be deleted`);
        } else {
          assert.deepEqual(store.get(id), expected.value, `value of ${id}`);
        }
      }
      // Recovery keeps the same guarantees: snapshot, restore, compare.
      const restored = SyncStore.restore<Value>(
        JSON.parse(JSON.stringify(store.snapshot())) as Snapshot<Value>,
      );
      for (const [id, expected] of reference) {
        assert.equal(restored.cursorOf(id), expected.cursor, `restored cursor of ${id}`);
        assert.deepEqual(restored.get(id), expected.value, `restored value of ${id}`);
      }
    });
  }

  it("converges even when a snapshot/restore happens mid-shuffle", () => {
    const random = rng(99);
    const log = generateLog(random, 4, 200);
    const reference = referenceApply(log);
    const queue = shuffle(log, random);
    let store = new SyncStore<Value>({ pendingBudget: 16 });
    let delivered = 0;
    let guard = 0;
    while (queue.length > 0) {
      assert.ok(guard < 1_000_000, "delivery made no progress");
      guard += 1;
      const change = queue.shift() as Change<Value>;
      if (store.receive(change).status === "backpressure") {
        queue.push(change);
        continue;
      }
      delivered += 1;
      if (delivered === 100) {
        // Crash and recover halfway through the stream.
        store = SyncStore.restore<Value>(
          JSON.parse(JSON.stringify(store.snapshot())) as Snapshot<Value>,
          { pendingBudget: 16 },
        );
      }
    }
    assert.equal(store.pendingCount(), 0);
    for (const [id, expected] of reference) {
      assert.equal(store.cursorOf(id), expected.cursor, `cursor of ${id}`);
      assert.deepEqual(store.get(id), expected.value, `value of ${id}`);
    }
  });
});
