import { test } from "node:test";
import assert from "node:assert/strict";
import {
  CausalBroadcast,
  verifyCausalOrder,
  type Message,
  type VectorClock,
} from "../src/index.js";

function msg(
  source: string,
  seq: number,
  deps: VectorClock = {},
  payload?: string,
): Message<string> {
  return {
    id: `${source}#${seq}`,
    source,
    seq,
    deps,
    payload: payload ?? `${source}-${seq}`,
  };
}

function ids(log: readonly Message<string>[]): string[] {
  return log.map((m) => m.id);
}

test("in-order messages are delivered immediately", () => {
  const node = new CausalBroadcast<string>();
  const r1 = node.receive(msg("A", 1));
  const r2 = node.receive(msg("A", 2, { A: 1 }));
  const r3 = node.receive(msg("B", 1, { A: 2 }));
  assert.equal(r1.status, "delivered");
  assert.equal(r2.status, "delivered");
  assert.equal(r3.status, "delivered");
  assert.deepEqual(ids(node.delivered()), ["A#1", "A#2", "B#1"]);
  assert.deepEqual(node.clock(), { A: 2, B: 1 });
});

test("out-of-order messages are buffered and cascade in causal order", () => {
  const node = new CausalBroadcast<string>();
  assert.equal(node.receive(msg("A", 3, { A: 2 })).status, "buffered");
  assert.equal(node.receive(msg("A", 2, { A: 1 })).status, "buffered");
  assert.equal(node.receive(msg("B", 1, { A: 3 })).status, "buffered");
  assert.deepEqual(ids(node.delivered()), []);

  const r = node.receive(msg("A", 1));
  assert.equal(r.status, "delivered");
  assert.deepEqual(ids(r.delivered), ["A#1", "A#2", "A#3", "B#1"]);
  assert.deepEqual(ids(node.delivered()), ["A#1", "A#2", "A#3", "B#1"]);
  assert.equal(node.pending().length, 0);
});

test("pending reasons explain exactly what is missing", () => {
  const node = new CausalBroadcast<string>();
  node.receive(msg("A", 1));
  const r = node.receive(msg("C", 3, { A: 2 }));
  assert.equal(r.status, "buffered");
  assert.deepEqual(r.pending, [
    { kind: "source-gap", source: "C", have: 0, need: 2 },
    { kind: "missing-dependency", source: "A", have: 1, need: 2 },
  ]);
  const pending = node.pending();
  assert.equal(pending.length, 1);
  assert.equal(pending[0]!.message.id, "C#3");
  assert.deepEqual(pending[0]!.reasons, r.pending);
  assert.deepEqual(node.pendingReasons("C#3"), r.pending);
  assert.equal(node.pendingReasons("nope"), undefined);
});

test("exact duplicates are idempotent, same id with different content is rejected", () => {
  const node = new CausalBroadcast<string>();
  const original = msg("A", 1, {}, "hello");
  assert.equal(node.receive(original).status, "delivered");

  const dup = node.receive({ ...original });
  assert.equal(dup.status, "duplicate");
  assert.deepEqual(ids(node.delivered()), ["A#1"]);

  const conflict = node.receive({ ...original, payload: "tampered" });
  assert.equal(conflict.status, "rejected");
  assert.ok(conflict.reason!.includes("conflicting content"));
  assert.deepEqual(ids(node.delivered()), ["A#1"]);

  // Also holds for buffered (not yet delivered) messages.
  const buffered = msg("A", 3, { A: 2 }, "three");
  assert.equal(node.receive(buffered).status, "buffered");
  assert.equal(node.receive({ ...buffered }).status, "duplicate");
  assert.equal(
    node.receive({ ...buffered, deps: { A: 1 } }).status,
    "rejected",
  );
});

test("malformed messages are rejected", () => {
  const node = new CausalBroadcast<string>();
  assert.equal(node.receive(msg("A", 0)).status, "rejected");
  assert.equal(node.receive(msg("A", 1.5)).status, "rejected");
  assert.equal(node.receive(msg("", 1)).status, "rejected");
  assert.equal(node.receive(msg("A", 1, { B: -1 })).status, "rejected");
  assert.equal(node.receive(msg("A", 1, { A: 1 })).status, "rejected");
  assert.equal(node.receive(msg("A", 1)).status, "delivered");
});

test("watermark rejects stale messages and skips the frontier ahead", () => {
  const node = new CausalBroadcast<string>();
  node.receive(msg("A", 1));

  // B#1 waits on A#2, which will never arrive.
  const buffered = node.receive(msg("B", 1, { A: 2 }));
  assert.equal(buffered.status, "buffered");
  assert.deepEqual(buffered.pending, [
    { kind: "missing-dependency", source: "A", have: 1, need: 2 },
  ]);

  // Declare: nothing with seq <= 2 will ever come from A again.
  const w = node.declareWatermark({ A: 2 });
  assert.deepEqual(ids(w.delivered), ["B#1"]); // dependency waived
  assert.deepEqual(w.orphaned, []);
  assert.deepEqual(node.watermark(), { A: 2 });

  // The promised-absent old message is rejected when it shows up anyway.
  const stale = node.receive(msg("A", 2, { A: 1 }));
  assert.equal(stale.status, "rejected");
  assert.ok(stale.reason!.includes("stale"));

  // The source resumes at watermark + 1.
  assert.equal(node.receive(msg("A", 3)).status, "delivered");
  assert.deepEqual(ids(node.delivered()), ["A#1", "B#1", "A#3"]);
});

test("watermark orphans buffered messages it overtakes", () => {
  const node = new CausalBroadcast<string>();
  node.receive(msg("A", 1));
  // B#2 is buffered because B#1 is missing.
  assert.equal(node.receive(msg("B", 2, { A: 1 })).status, "buffered");

  const w = node.declareWatermark({ B: 2 });
  assert.equal(w.orphaned.length, 1);
  assert.equal(w.orphaned[0]!.message.id, "B#2");
  assert.deepEqual(w.orphaned[0]!.reasons, [
    { kind: "below-watermark", source: "B", have: 2, need: 2 },
  ]);
  assert.deepEqual(node.orphans(), w.orphaned);
  assert.equal(node.pending().length, 0);
});

test("watermarks are monotone", () => {
  const node = new CausalBroadcast<string>();
  node.declareWatermark({ A: 2 });
  node.declareWatermark({ A: 2 }); // same is fine
  node.declareWatermark({ A: 5 });
  assert.throws(() => node.declareWatermark({ A: 4 }));
  assert.throws(() => node.declareWatermark({ A: -1 }));
  assert.deepEqual(node.watermark(), { A: 5 });
});

// --- Property tests: arbitrary input reorderings never violate causality ---

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

function shuffle<T>(items: T[], rnd: () => number): T[] {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    [out[i], out[j]] = [out[j]!, out[i]!];
  }
  return out;
}

/**
 * Simulates a cluster: nodes randomly receive each other's messages (merging
 * vector clocks) and broadcast new ones depending on everything seen so far.
 * Returns every message ever broadcast, in creation order.
 */
function generateTraffic(
  seed: number,
  sourceCount: number,
  steps: number,
): Message<string>[] {
  const rnd = mulberry32(seed);
  const sources = Array.from({ length: sourceCount }, (_, i) => `N${i}`);
  const views: VectorClock[] = sources.map(() => ({}));
  const seqs: number[] = sources.map(() => 0);
  const created: { msg: Message<string>; vector: VectorClock }[] = [];

  for (let step = 0; step < steps; step++) {
    const node = Math.floor(rnd() * sourceCount);
    if (created.length > 0 && rnd() < 0.4) {
      // Node "receives" a random existing message: merge its clock.
      const m = created[Math.floor(rnd() * created.length)]!;
      for (const [src, n] of Object.entries(m.vector)) {
        const view = views[node]!;
        view[src] = Math.max(view[src] ?? 0, n);
      }
    } else {
      // Node broadcasts: depends on everything it has seen.
      seqs[node]! += 1;
      const seq = seqs[node]!;
      const deps: VectorClock = {};
      for (const [src, n] of Object.entries(views[node]!)) {
        if (src !== sources[node] && n > 0) deps[src] = n;
      }
      const message: Message<string> = {
        id: `${sources[node]}#${seq}`,
        source: sources[node]!,
        seq,
        deps,
        payload: `payload-${sources[node]}-${seq}`,
      };
      const vector = { ...views[node]!, [sources[node]!]: seq };
      views[node]![sources[node]!] = seq;
      created.push({ msg: message, vector });
    }
  }
  return created.map((c) => c.msg);
}

/**
 * Independent topological reference: the delivery log must be a linear
 * extension of the causal partial order (per-source chains + dep edges).
 */
function assertLinearExtension(
  log: readonly Message<string>[],
  all: readonly Message<string>[],
): void {
  const byKey = new Map(all.map((m) => [`${m.source}#${m.seq}`, m]));
  const position = new Map(log.map((m, i) => [m.id, i]));
  assert.equal(position.size, log.length, "duplicate ids in delivery log");
  for (const m of log) {
    const here = position.get(m.id)!;
    if (m.seq > 1) {
      const pred = byKey.get(`${m.source}#${m.seq - 1}`)!;
      assert.ok(
        position.get(pred.id)! < here,
        `${m.id} delivered before its per-source predecessor ${pred.id}`,
      );
    }
    for (const [node, n] of Object.entries(m.deps)) {
      const dep = byKey.get(`${node}#${n}`)!;
      assert.ok(
        position.get(dep.id)! < here,
        `${m.id} delivered before its dependency ${dep.id}`,
      );
    }
  }
}

test("arbitrary input reorderings deliver exactly the causal linear extensions", () => {
  for (let seed = 1; seed <= 25; seed++) {
    const traffic = generateTraffic(seed, 3, 80);
    assert.ok(traffic.length > 0);
    const expectedClock: VectorClock = {};
    for (const m of traffic) {
      expectedClock[m.source] = Math.max(expectedClock[m.source] ?? 0, m.seq);
    }

    for (let trial = 0; trial < 6; trial++) {
      const shuffled = shuffle(traffic, mulberry32(seed * 1000 + trial));
      const node = new CausalBroadcast<string>();
      for (const m of shuffled) {
        const r = node.receive(m);
        assert.notEqual(r.status, "rejected", `unexpected reject: ${r.reason}`);
        // Causality must hold at every intermediate prefix, not just at end.
        assert.ok(verifyCausalOrder(node.delivered()));
      }
      const log = node.delivered();
      assert.equal(log.length, traffic.length, "all messages delivered");
      assert.equal(node.pending().length, 0, "nothing left buffered");
      assert.ok(verifyCausalOrder(log));
      assertLinearExtension(log, traffic);
      assert.deepEqual(
        [...ids(log)].sort(),
        traffic.map((m) => m.id).sort(),
        "delivered set equals input set",
      );
      assert.deepEqual(node.clock(), expectedClock);
    }
  }
});

test("duplicates injected into a shuffled stream stay idempotent", () => {
  const traffic = generateTraffic(42, 4, 60);
  const rnd = mulberry32(7);
  const withDups = shuffle(
    traffic.flatMap((m) => (rnd() < 0.3 ? [m, { ...m }] : [m])),
    rnd,
  );
  const node = new CausalBroadcast<string>();
  let duplicates = 0;
  for (const m of withDups) {
    const r = node.receive(m);
    if (r.status === "duplicate") duplicates++;
    assert.notEqual(r.status, "rejected");
  }
  assert.ok(duplicates > 0, "expected some duplicates to be exercised");
  assert.equal(node.delivered().length, traffic.length);
  assert.ok(verifyCausalOrder(node.delivered()));
  assertLinearExtension(node.delivered(), traffic);
});
