import { test } from "node:test";
import assert from "node:assert/strict";
import { RectSnapshot, type CoveredRect, type Entry, type Rect } from "../src/rectdb.js";
import { modelCellsAtLeast, totalArea, verifyAgainstModel } from "../src/model.js";

function cov(x0: number, y0: number, x1: number, y1: number, sources: string[]): CoveredRect {
  return { x0, y0, x1, y1, sources };
}

test("overlapping rects decompose into canonical disjoint slabs", () => {
  let s = RectSnapshot.empty();
  const a = s.insert({ x0: 0, y0: 0, x1: 3, y1: 3 }, "a");
  const b = a.snapshot.insert({ x0: 1, y0: 1, x1: 4, y1: 4 }, "b");
  s = b.snapshot;

  assert.deepEqual(s.coveredAtLeast(1), [
    cov(0, 0, 1, 3, ["a"]),
    cov(1, 0, 3, 1, ["a"]),
    cov(1, 1, 3, 3, ["a", "b"]),
    cov(1, 3, 3, 4, ["b"]),
    cov(3, 1, 4, 4, ["b"]),
  ]);
  assert.deepEqual(s.coveredAtLeast(2), [cov(1, 1, 3, 3, ["a", "b"])]);
  assert.deepEqual(s.coveredAtLeast(3), []);
});

test("same-x endpoint events are batched: adjacent rects merge, no zero-width slabs", () => {
  let s = RectSnapshot.empty();
  s = s.insert({ x0: 0, y0: 0, x1: 2, y1: 2 }, "a").snapshot;
  s = s.insert({ x0: 2, y0: 0, x1: 4, y1: 2 }, "a").snapshot;
  // Shared edge at x=2: identical bands on both sides merge horizontally.
  assert.deepEqual(s.coveredAtLeast(1), [cov(0, 0, 4, 2, ["a"])]);

  // Different sources on each side of the shared edge stay separate.
  const t = s.insert({ x0: 4, y0: 0, x1: 6, y1: 2 }, "b").snapshot;
  assert.deepEqual(t.coveredAtLeast(1), [
    cov(0, 0, 4, 2, ["a"]),
    cov(4, 0, 6, 2, ["b"]),
  ]);
});

test("holes are preserved as gaps in the output", () => {
  let s = RectSnapshot.empty();
  // A 3x3 frame around the missing center cell (1,1).
  s = s.insert({ x0: 0, y0: 0, x1: 3, y1: 1 }, "f").snapshot;
  s = s.insert({ x0: 0, y0: 2, x1: 3, y1: 3 }, "f").snapshot;
  s = s.insert({ x0: 0, y0: 1, x1: 1, y1: 2 }, "f").snapshot;
  s = s.insert({ x0: 2, y0: 1, x1: 3, y1: 2 }, "f").snapshot;

  const out = s.coveredAtLeast(1);
  assert.deepEqual(out, [
    cov(0, 0, 1, 3, ["f"]),
    cov(1, 0, 2, 1, ["f"]),
    cov(1, 2, 2, 3, ["f"]),
    cov(2, 0, 3, 3, ["f"]),
  ]);
  assert.equal(totalArea(out), 8);
  for (const r of out) {
    assert.ok(!(r.x0 <= 1 && 1 < r.x1 && r.y0 <= 1 && 1 < r.y1), "hole cell must stay uncovered");
  }
});

test("k-coverage hole: ring covered twice around a singly covered center", () => {
  let s = RectSnapshot.empty();
  s = s.insert({ x0: 0, y0: 0, x1: 3, y1: 3 }, "a").snapshot; // base layer
  s = s.insert({ x0: 0, y0: 0, x1: 3, y1: 1 }, "b").snapshot;
  s = s.insert({ x0: 0, y0: 2, x1: 3, y1: 3 }, "b").snapshot;
  s = s.insert({ x0: 0, y0: 1, x1: 1, y1: 2 }, "b").snapshot;
  s = s.insert({ x0: 2, y0: 1, x1: 3, y1: 2 }, "b").snapshot;

  const out = s.coveredAtLeast(2);
  assert.deepEqual(out, [
    cov(0, 0, 1, 3, ["a", "b"]),
    cov(1, 0, 2, 1, ["a", "b"]),
    cov(1, 2, 2, 3, ["a", "b"]),
    cov(2, 0, 3, 3, ["a", "b"]),
  ]);
  assert.equal(totalArea(out), 8);
});

test("old snapshots are never modified by later inserts/removes", () => {
  const s0 = RectSnapshot.empty();
  const r1 = s0.insert({ x0: 0, y0: 0, x1: 2, y1: 2 }, "a");
  const s1 = r1.snapshot;
  const before1 = s1.coveredAtLeast(1);

  const r2 = s1.insert({ x0: 1, y0: 1, x1: 3, y1: 3 }, "b");
  const s2 = r2.snapshot;
  const s3 = s2.remove(r1.id);

  assert.equal(s0.size, 0);
  assert.equal(s1.size, 1);
  assert.equal(s2.size, 2);
  assert.equal(s3.size, 1);
  assert.deepEqual(s1.coveredAtLeast(1), before1);
  assert.deepEqual(s1.coveredAtLeast(1), [cov(0, 0, 2, 2, ["a"])]);
  assert.deepEqual(s3.coveredAtLeast(1), [cov(1, 1, 3, 3, ["b"])]);
  assert.ok(s1.has(r1.id) && !s3.has(r1.id));
});

test("decomposition is canonical: independent of insertion order", () => {
  const rects: Array<[Rect, string]> = [
    [{ x0: 0, y0: 0, x1: 4, y1: 2 }, "a"],
    [{ x0: 1, y0: 1, x1: 3, y1: 5 }, "b"],
    [{ x0: 2, y0: 0, x1: 6, y1: 4 }, "a"],
    [{ x0: 0, y0: 3, x1: 2, y1: 6 }, "c"],
  ];
  const orders = [
    [0, 1, 2, 3],
    [3, 2, 1, 0],
    [1, 3, 0, 2],
  ];
  const outputs = orders.map((order) => {
    let s = RectSnapshot.empty();
    for (const i of order) {
      const [rect, source] = rects[i]!;
      s = s.insert(rect, source).snapshot;
    }
    return s.coveredAtLeast(2);
  });
  assert.deepEqual(outputs[1], outputs[0]);
  assert.deepEqual(outputs[2], outputs[0]);
});

test("remove restores pre-insert coverage exactly", () => {
  let s = RectSnapshot.empty();
  s = s.insert({ x0: 0, y0: 0, x1: 5, y1: 5 }, "base").snapshot;
  const before = s.coveredAtLeast(1);
  const tmp = s.insert({ x0: 2, y0: 2, x1: 7, y1: 7 }, "tmp");
  const after = tmp.snapshot.remove(tmp.id);
  assert.deepEqual(after.coveredAtLeast(1), before);
  assert.deepEqual(after.coveredAtLeast(2), []);
});

test("invalid inputs are rejected", () => {
  const s = RectSnapshot.empty();
  assert.throws(() => s.insert({ x0: 0.5, y0: 0, x1: 2, y1: 2 }, "a"), RangeError);
  assert.throws(() => s.insert({ x0: 2, y0: 0, x1: 2, y1: 2 }, "a"), RangeError);
  assert.throws(() => s.insert({ x0: 0, y0: 3, x1: 2, y1: 1 }, "a"), RangeError);
  assert.throws(() => s.remove(42), RangeError);
  assert.throws(() => s.coveredAtLeast(0), RangeError);
  assert.throws(() => s.coveredAtLeast(1.5), RangeError);
});

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

test("randomized cross-check against per-cell model (area and sources)", () => {
  const GRID = 7;
  const SOURCES = ["s0", "s1", "s2", "s3"];
  const rand = mulberry32(0xC0FFEE);
  const ri = (n: number) => Math.floor(rand() * n);

  for (let trial = 0; trial < 200; trial++) {
    let snap = RectSnapshot.empty();
    const live = new Map<number, Entry>();
    // Keep an old snapshot midway and verify it stays frozen.
    let frozen: { snap: RectSnapshot; out1: readonly CoveredRect[] } | null = null;

    const ops = 5 + ri(20);
    for (let op = 0; op < ops; op++) {
      if (live.size > 0 && rand() < 0.35) {
        const ids = [...live.keys()];
        const id = ids[ri(ids.length)]!;
        snap = snap.remove(id);
        live.delete(id);
      } else {
        const x0 = ri(GRID);
        const y0 = ri(GRID);
        const x1 = x0 + 1 + ri(GRID - x0);
        const y1 = y0 + 1 + ri(GRID - y0);
        const source = SOURCES[ri(SOURCES.length)]!;
        const res = snap.insert({ x0, y0, x1, y1 }, source);
        snap = res.snapshot;
        live.set(res.id, { id: res.id, rect: { x0, y0, x1, y1 }, source });
      }
      if (op === Math.floor(ops / 2)) {
        frozen = { snap, out1: snap.coveredAtLeast(1) };
      }
    }

    const entries = [...live.values()];
    for (const k of [1, 2, 3]) {
      const out = snap.coveredAtLeast(k);
      const mismatches = verifyAgainstModel(entries, k, out);
      assert.deepEqual(mismatches, [], `trial ${trial} k=${k}: ${JSON.stringify(mismatches)}`);
      const expectedCells = modelCellsAtLeast(entries, k);
      assert.equal(totalArea(out), expectedCells.size, `trial ${trial} k=${k} area`);
    }

    if (frozen !== null) {
      assert.deepEqual(frozen.snap.coveredAtLeast(1), frozen.out1, `trial ${trial} frozen snapshot changed`);
    }
  }
});

test("randomized immutability: full history of snapshots stays intact", () => {
  const rand = mulberry32(1234);
  const ri = (n: number) => Math.floor(rand() * n);
  const history: Array<{ snap: RectSnapshot; entries: Entry[] }> = [];

  let snap = RectSnapshot.empty();
  const live = new Map<number, Entry>();
  for (let op = 0; op < 60; op++) {
    if (live.size > 0 && rand() < 0.4) {
      const ids = [...live.keys()];
      const id = ids[ri(ids.length)]!;
      snap = snap.remove(id);
      live.delete(id);
    } else {
      const x0 = ri(6);
      const y0 = ri(6);
      const rect = { x0, y0, x1: x0 + 1 + ri(5), y1: y0 + 1 + ri(5) };
      const source = `src${ri(3)}`;
      const res = snap.insert(rect, source);
      snap = res.snapshot;
      live.set(res.id, { id: res.id, rect, source });
    }
    history.push({ snap, entries: [...live.values()] });
  }

  // Re-query every historical snapshot: results must match its own model.
  for (let i = 0; i < history.length; i++) {
    const h = history[i]!;
    assert.equal(h.snap.size, h.entries.length);
    for (const k of [1, 2]) {
      const mismatches = verifyAgainstModel(h.entries, k, h.snap.coveredAtLeast(k));
      assert.deepEqual(mismatches, [], `snapshot ${i} k=${k}`);
    }
  }
});
