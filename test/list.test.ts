import { test } from "node:test";
import assert from "node:assert/strict";
import { CrdtList, compareOpId, type Op } from "../src/list.js";
import { fracBetween } from "../src/fraction.js";

/** Deterministic PRNG (mulberry32) so fuzz runs are reproducible. */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function shuffled<T>(arr: T[], rand: () => number): T[] {
  const out = [...arr];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [out[i], out[j]] = [out[j]!, out[i]!];
  }
  return out;
}

test("fraction: keys stay strictly between bounds", () => {
  const keys: string[] = [];
  // Always insert into a random gap; the array must remain sorted.
  const rand = rng(7);
  for (let n = 0; n < 500; n++) {
    const i = Math.floor(rand() * (keys.length + 1));
    const left = i > 0 ? keys[i - 1]! : "";
    const right = i < keys.length ? keys[i]! : "";
    const k = fracBetween(left, right);
    assert.ok(left === "" || k > left, `${k} > ${left}`);
    assert.ok(right === "" || k < right, `${k} < ${right}`);
    keys.splice(i, 0, k);
  }
  const sorted = [...keys].sort();
  assert.deepEqual(keys, sorted);
});

test("stable IDs: deletes never free IDs and IDs are never reused", () => {
  const list = new CrdtList<string>("A");
  const a = list.insert("a");
  const b = list.insert("b");
  list.delete(a.id);
  const c = list.insert("c");
  const ids = [a.id, b.id, c.id];
  assert.equal(new Set(ids).size, 3, "IDs unique");
  assert.ok(list.has(a.id), "deleted ID stays reserved (tombstone)");
  assert.ok(!list.isLive(a.id));
  assert.deepEqual(list.values(), ["b", "c"]);
});

test("moves are versioned: an old move arriving late does not reorder", () => {
  const a = new CrdtList<string>("A");
  const x = a.insert("x");
  const y = a.insert("y");
  const z = a.insert("z");
  const move1 = a.move(x.id, 2); // x to end: y z x
  const move2 = a.move(x.id, 0); // x back to front: x y z
  assert.deepEqual(a.ids(), [x.id, y.id, z.id]);

  // Replica B receives the newer move first, then the stale one.
  const b = new CrdtList<string>("B");
  b.merge([x.op, y.op, z.op, move2, move1]);
  assert.deepEqual(b.ids(), [x.id, y.id, z.id], "stale move must not win");

  // And in the opposite delivery order.
  const c = new CrdtList<string>("C");
  c.merge([x.op, y.op, z.op, move1, move2]);
  assert.deepEqual(c.ids(), [x.id, y.id, z.id]);
});

test("an old move cannot resurrect a causally-later-deleted element", () => {
  const a = new CrdtList<string>("A");
  const x = a.insert("x");
  const keep = a.insert("keep");
  const oldMove = a.move(x.id, 0); // will be replayed later
  const del = a.delete(x.id);      // causally after oldMove
  assert.ok(!a.isLive(x.id));

  // Replica B gets the delete first, then the stale move: stays deleted.
  const b = new CrdtList<string>("B");
  b.merge([x.op, keep.op, del, oldMove]);
  assert.ok(!b.isLive(x.id), "stale move must not resurrect");
  assert.deepEqual(b.values(), ["keep"]);

  // Re-applying the delete after the move also stays deleted.
  const c = new CrdtList<string>("C");
  c.merge([x.op, keep.op, oldMove, del, oldMove]);
  assert.ok(!c.isLive(x.id));
  assert.deepEqual(c.values(), ["keep"]);
});

test("a move concurrent with a delete wins and keeps the element live", () => {
  const a = new CrdtList<string>("A");
  const x = a.insert("x");
  a.insert("keep");

  // Fork: B deletes x without seeing A's later move.
  const b = new CrdtList<string>("B");
  b.merge(a.ops());
  const del = b.delete(x.id);

  // A concurrently moves x (no knowledge of the delete).
  const mv = a.move(x.id, 0);

  a.apply(del);
  b.apply(mv);
  assert.ok(a.isLive(x.id), "concurrent move beats delete");
  assert.ok(b.isLive(x.id));
  assert.deepEqual(a.ids(), b.ids(), "both replicas converge");
});

test("concurrent moves are resolved by operation ID on every replica", () => {
  const mk = (): { l: CrdtList<string>; ops: Op[]; x: string } => {
    const l = new CrdtList<string>("S");
    const x = l.insert("x").id;
    l.insert("y");
    l.insert("z");
    return { l, ops: [...l.ops()], x };
  };
  const base = mk();
  const a = new CrdtList<string>("A");
  const b = new CrdtList<string>("B");
  a.merge(base.ops);
  b.merge(base.ops);

  const ma = a.move(base.x, 2); // A: x -> end
  const mb = b.move(base.x, 0); // B: x -> front (concurrent)

  const winner = compareOpId(ma.at.version, mb.at.version) > 0 ? ma : mb;
  const expected = winner === ma ? ["y", "z", "x"] : ["x", "y", "z"];

  // Deliver in opposite orders to the two replicas.
  a.apply(mb);
  b.apply(ma);
  assert.deepEqual(a.values(), expected);
  assert.deepEqual(b.values(), expected);
  assert.deepEqual(a.ids(), b.ids(), "convergent regardless of order");
});

test("re-applying an op is idempotent", () => {
  const a = new CrdtList<string>("A");
  const x = a.insert("x");
  const mv = a.move(x.id, 0);
  const del = a.delete(x.id);
  const b = new CrdtList<string>("B");
  assert.equal(b.merge([x.op, mv, del]), 3);
  assert.equal(b.merge([x.op, mv, del]), 0, "second application changes nothing");
  assert.deepEqual(b.values(), []);
});

test("out-of-order shuffle merge converges; each element appears at most once", () => {
  for (const seed of [1, 2, 3, 42, 1337]) {
    const rand = rng(seed);
    const names = ["A", "B", "C"];
    const replicas = names.map((n) => new CrdtList<number>(n));
    const allOps: Op[] = [];
    const liveIds: string[][] = replicas.map(() => []);

    // Phase 1: each replica inserts a few elements; share everything.
    for (let r = 0; r < replicas.length; r++) {
      for (let k = 0; k < 4; k++) {
        const { id, op } = replicas[r]!.insert(r * 100 + k);
        allOps.push(op);
        liveIds[r]!.push(id);
      }
    }
    for (const r of replicas) r.merge(shuffled(allOps, rand));

    // Phase 2: random concurrent moves and deletes on each replica.
    const allIds = liveIds.flat();
    for (const r of replicas) {
      for (let k = 0; k < 6; k++) {
        const id = allIds[Math.floor(rand() * allIds.length)]!;
        if (rand() < 0.4) {
          allOps.push(r.delete(id));
        } else {
          allOps.push(r.move(id, Math.floor(rand() * 8)));
        }
      }
    }

    // Phase 3: deliver the full op log to everyone in random orders.
    for (const r of replicas) r.merge(shuffled(allOps, rand));

    // A fresh replica merging everything in another random order agrees.
    const fresh = new CrdtList<number>("F");
    fresh.merge(shuffled(allOps, rand));

    const reference = replicas[0]!.entries();
    for (const r of [...replicas.slice(1), fresh]) {
      assert.deepEqual(r.entries(), reference, `seed ${seed}: convergence`);
    }
    const ids = reference.map((e) => e.id);
    assert.equal(new Set(ids).size, ids.length, `seed ${seed}: no duplicates`);
  }
});

test("move before insert arrives (out-of-order) still converges", () => {
  const a = new CrdtList<string>("A");
  const x = a.insert("x");
  a.insert("y");
  const mv = a.move(x.id, 1);

  const b = new CrdtList<string>("B");
  b.apply(mv); // move arrives before the insert
  b.merge(a.ops());
  assert.deepEqual(b.entries(), a.entries());
});
