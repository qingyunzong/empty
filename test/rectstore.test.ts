import { describe, it } from "node:test";
import {
  deepStrictEqual,
  equal,
  ok,
  strictEqual,
  throws,
} from "node:assert/strict";
import { rect, RectStore, type CoverageRect } from "../src/rectstore.js";
import { gridCoverage, verifyCoverage } from "../src/gridmodel.js";

const mulberry32 = (seed: number): (() => number) => {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
};

const asPlain = (cs: readonly CoverageRect[]): unknown =>
  cs.map((c) => ({ rect: { ...c.rect }, sources: [...c.sources] }));

describe("validation", () => {
  it("rejects non-integer and degenerate rectangles", () => {
    const s = RectStore.empty();
    throws(() => s.add("a", rect(0, 0, 1.5, 2)));
    throws(() => s.add("a", rect(0, 0, 0, 2)));
    throws(() => s.add("a", rect(3, 0, 1, 2)));
    throws(() => s.add("a", rect(0, 2, 1, 2)));
    throws(() => rect(0, 0, Number.NaN, 1));
  });

  it("rejects invalid k", () => {
    const s = RectStore.empty().add("a", rect(0, 0, 2, 2));
    throws(() => s.coverage(0));
    throws(() => s.coverage(1.5));
    throws(() => s.coverage(-2));
  });

  it("empty store yields empty coverage", () => {
    deepStrictEqual(RectStore.empty().coverage(1), []);
  });
});

describe("basic coverage", () => {
  it("single rectangle at k=1", () => {
    const s = RectStore.empty<string>().add("a", rect(1, 2, 4, 6));
    deepStrictEqual(asPlain(s.coverage(1)), [
      { rect: { x0: 1, y0: 2, x1: 4, y1: 6 }, sources: ["a"] },
    ]);
    deepStrictEqual(s.coverage(2), []);
  });

  it("overlap of two rectangles at k=2", () => {
    const s = RectStore.empty<string>()
      .add("a", rect(0, 0, 4, 4))
      .add("b", rect(2, 2, 6, 6));
    deepStrictEqual(asPlain(s.coverage(2)), [
      { rect: { x0: 2, y0: 2, x1: 4, y1: 4 }, sources: ["a", "b"] },
    ]);
  });

  it("k=1 splits regions by distinct source sets", () => {
    const s = RectStore.empty<string>()
      .add("a", rect(0, 0, 4, 4))
      .add("b", rect(2, 0, 6, 4));
    deepStrictEqual(asPlain(s.coverage(1)), [
      { rect: { x0: 0, y0: 0, x1: 2, y1: 4 }, sources: ["a"] },
      { rect: { x0: 2, y0: 0, x1: 4, y1: 4 }, sources: ["a", "b"] },
      { rect: { x0: 4, y0: 0, x1: 6, y1: 4 }, sources: ["b"] },
    ]);
  });

  it("supports numeric ids with canonical ordering", () => {
    const s = RectStore.empty<number>()
      .add(10, rect(0, 0, 2, 2))
      .add(2, rect(0, 0, 2, 2));
    deepStrictEqual(asPlain(s.coverage(2)), [
      { rect: { x0: 0, y0: 0, x1: 2, y1: 2 }, sources: [2, 10] },
    ]);
  });
});

describe("holes", () => {
  it("a ring of rectangles keeps its hole uncovered", () => {
    const s = RectStore.empty<string>()
      .add("top", rect(0, 0, 4, 1))
      .add("bottom", rect(0, 3, 4, 4))
      .add("left", rect(0, 1, 1, 3))
      .add("right", rect(3, 1, 4, 3));
    const out = s.coverage(1);
    verifyCoverage(s.entries(), 1, out);
    for (const c of out) {
      const r = c.rect;
      // Hole is the 2x2 region (1,1)-(3,3).
      const overlapsHole =
        r.x0 < 3 && r.x1 > 1 && r.y0 < 3 && r.y1 > 1;
      ok(!overlapsHole, `rect ${JSON.stringify(r)} spans the hole`);
    }
    equal(gridCoverage(s.entries(), 1).area, 12);
  });

  it("nested rectangles: k=2 keeps only the core, k=3 leaves a hole", () => {
    const s = RectStore.empty<string>()
      .add("a", rect(0, 0, 6, 6))
      .add("b", rect(1, 1, 5, 5))
      .add("c", rect(2, 2, 4, 4));
    const core = s.coverage(3);
    deepStrictEqual(asPlain(core), [
      { rect: { x0: 2, y0: 2, x1: 4, y1: 4 }, sources: ["a", "b", "c"] },
    ]);
    const mid = s.coverage(2);
    verifyCoverage(s.entries(), 2, mid);
    equal(mid.reduce((n, c) => n + (c.rect.x1 - c.rect.x0) * (c.rect.y1 - c.rect.y0), 0), 16);
  });
});

describe("persistence", () => {
  it("mutations never change existing snapshots", () => {
    const s0 = RectStore.empty<string>();
    const s1 = s0.add("a", rect(0, 0, 4, 4));
    const s2 = s1.add("b", rect(2, 2, 6, 6));
    const s3 = s2.remove("a");

    const before1 = asPlain(s1.coverage(1));
    const before2 = asPlain(s2.coverage(2));

    // Later mutations happen after the snapshots above were taken.
    const s4 = s3.add("c", rect(0, 0, 10, 1)).remove("b");
    ok(s4 !== s3);

    strictEqual(s0.size, 0);
    strictEqual(s1.size, 1);
    strictEqual(s2.size, 2);
    strictEqual(s3.size, 1);
    ok(!s3.has("a"));
    ok(s1.has("a"));
    deepStrictEqual(asPlain(s1.coverage(1)), before1);
    deepStrictEqual(asPlain(s2.coverage(2)), before2);
    deepStrictEqual(asPlain(s3.coverage(1)), [
      { rect: { x0: 2, y0: 2, x1: 6, y1: 6 }, sources: ["b"] },
    ]);
  });

  it("add replaces an existing id; removing a missing id is a no-op", () => {
    const s1 = RectStore.empty<string>().add("a", rect(0, 0, 2, 2));
    const s2 = s1.add("a", rect(0, 0, 3, 3));
    strictEqual(s2.size, 1);
    deepStrictEqual(s2.get("a"), { x0: 0, y0: 0, x1: 3, y1: 3 });
    deepStrictEqual(s1.get("a"), { x0: 0, y0: 0, x1: 2, y1: 2 });
    const s3 = s2.remove("nope");
    ok(s3 === s2);
  });
});

describe("batched sweep events", () => {
  it("touching rectangles produce no zero-width output", () => {
    const s = RectStore.empty<string>()
      .add("a", rect(0, 0, 2, 2))
      .add("b", rect(2, 0, 4, 2))
      .add("c", rect(2, 2, 4, 4))
      .add("d", rect(0, 2, 2, 4));
    const out = s.coverage(1);
    verifyCoverage(s.entries(), 1, out);
    for (const c of out) {
      ok(c.rect.x0 < c.rect.x1 && c.rect.y0 < c.rect.y1);
    }
    equal(out.length, 4);
  });

  it("end/start at the same coordinate cancel without splitting runs", () => {
    // b ends exactly where c begins in y; the {a} run must stay one rect.
    const s = RectStore.empty<string>()
      .add("a", rect(0, 0, 4, 6))
      .add("b", rect(0, 0, 4, 3))
      .add("c", rect(0, 3, 4, 6));
    deepStrictEqual(asPlain(s.coverage(1)), [
      { rect: { x0: 0, y0: 0, x1: 4, y1: 3 }, sources: ["a", "b"] },
      { rect: { x0: 0, y0: 3, x1: 4, y1: 6 }, sources: ["a", "c"] },
    ]);
    verifyCoverage(s.entries(), 1, s.coverage(1));
  });
});

describe("canonical output", () => {
  it("is independent of insertion order", () => {
    const rects: [string, ReturnType<typeof rect>][] = [
      ["a", rect(0, 0, 5, 5)],
      ["b", rect(3, 1, 8, 4)],
      ["c", rect(1, 3, 6, 7)],
      ["d", rect(2, 2, 4, 3)],
    ];
    const permutations: number[][] = [
      [0, 1, 2, 3],
      [3, 2, 1, 0],
      [1, 3, 0, 2],
      [2, 0, 3, 1],
    ];
    const results = permutations.map((perm) => {
      let s = RectStore.empty<string>();
      for (const i of perm) {
        const [id, r] = rects[i]!;
        s = s.add(id, r);
      }
      for (const k of [1, 2, 3]) verifyCoverage(s.entries(), k, s.coverage(k));
      return asPlain(s.coverage(2));
    });
    for (const r of results) deepStrictEqual(r, results[0]);
  });
});

describe("randomized cross-check against the unit-grid model", () => {
  it("sweep matches cell-by-cell area and sources on tiny grids", () => {
    const rand = mulberry32(0x5eed);
    for (let iter = 0; iter < 200; iter++) {
      let s = RectStore.empty<number>();
      const n = 1 + Math.floor(rand() * 8);
      for (let i = 0; i < n; i++) {
        const x0 = Math.floor(rand() * 10);
        const y0 = Math.floor(rand() * 10);
        const x1 = x0 + 1 + Math.floor(rand() * (11 - x0 - 1));
        const y1 = y0 + 1 + Math.floor(rand() * (11 - y0 - 1));
        s = s.add(i, rect(x0, y0, Math.min(x1, 11), Math.min(y1, 11)));
      }
      for (let k = 1; k <= 3; k++) {
        verifyCoverage(s.entries(), k, s.coverage(k));
      }
    }
  });

  it("random mutation sequences keep old snapshots intact", () => {
    const rand = mulberry32(0xc0ffee);
    for (let iter = 0; iter < 60; iter++) {
      let s = RectStore.empty<number>();
      const snapshots: { store: RectStore<number>; k: number; expected: unknown }[] = [];
      const live = new Set<number>();
      for (let step = 0; step < 25; step++) {
        if (live.size > 0 && rand() < 0.35) {
          const ids = [...live];
          const victim = ids[Math.floor(rand() * ids.length)]!;
          live.delete(victim);
          s = s.remove(victim);
        } else {
          const id = Math.floor(rand() * 12);
          const x0 = Math.floor(rand() * 8);
          const y0 = Math.floor(rand() * 8);
          const x1 = x0 + 1 + Math.floor(rand() * 4);
          const y1 = y0 + 1 + Math.floor(rand() * 4);
          live.add(id);
          s = s.add(id, rect(x0, y0, x1, y1));
        }
        const k = 1 + Math.floor(rand() * 3);
        const out = s.coverage(k);
        verifyCoverage(s.entries(), k, out);
        if (rand() < 0.3) snapshots.push({ store: s, k, expected: asPlain(out) });
      }
      for (const snap of snapshots) {
        deepStrictEqual(asPlain(snap.store.coverage(snap.k)), snap.expected as never);
      }
    }
  });
});
