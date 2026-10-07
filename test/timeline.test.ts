import { describe, it } from "node:test";
import * as assert from "node:assert/strict";
import {
  FixedRowConflictError,
  InvalidTimelineItemError,
  TimelineItem,
  layoutTimeline,
  minRowsExhaustive,
  overlaps,
} from "../src/timeline";

function rowsOf(result: { rows: ReadonlyMap<string, number> }) {
  return Object.fromEntries(result.rows);
}

function assertLayoutValid(
  items: readonly TimelineItem[],
  rows: ReadonlyMap<string, number>
) {
  assert.equal(rows.size, items.length, "every item must be assigned");
  for (const item of items) {
    const row = rows.get(item.id);
    assert.ok(row !== undefined && row >= 0, `item ${item.id} has a row`);
    if (item.fixedRow !== undefined) {
      assert.equal(row, item.fixedRow, `fixed row of ${item.id} honored`);
    }
  }
  for (let i = 0; i < items.length; i++) {
    for (let j = i + 1; j < items.length; j++) {
      const a = items[i]!;
      const b = items[j]!;
      if (overlaps(a, b)) {
        assert.notEqual(
          rows.get(a.id),
          rows.get(b.id),
          `overlapping ${a.id} and ${b.id} must not share a row`
        );
      }
    }
  }
}

describe("half-open interval semantics", () => {
  it("treats touching intervals as non-overlapping", () => {
    assert.ok(overlaps({ id: "a", start: 0, end: 3 }, { id: "b", start: 2, end: 5 }));
    assert.ok(!overlaps({ id: "a", start: 0, end: 2 }, { id: "b", start: 2, end: 5 }));
    assert.ok(!overlaps({ id: "a", start: 2, end: 5 }, { id: "b", start: 0, end: 2 }));
  });

  it("shares a row for back-to-back intervals", () => {
    const result = layoutTimeline([
      { id: "a", start: 0, end: 2 },
      { id: "b", start: 2, end: 4 },
      { id: "c", start: 4, end: 6 },
    ]);
    assert.equal(result.rowCount, 1);
    assert.deepEqual(rowsOf(result), { a: 0, b: 0, c: 0 });
  });
});

describe("greedy assignment", () => {
  it("uses one row per interval in the max overlap depth", () => {
    const result = layoutTimeline([
      { id: "a", start: 0, end: 10 },
      { id: "b", start: 1, end: 2 },
      { id: "c", start: 2, end: 3 },
      { id: "d", start: 1.5, end: 4 },
    ]);
    assert.equal(result.rowCount, 3);
    assert.deepEqual(rowsOf(result), { a: 0, b: 1, d: 2, c: 1 });
  });

  it("orders by start, then id, and prefers the lowest free row", () => {
    // b and c start together; id order places b first. c reuses the row
    // freed by a instead of opening a new one.
    const result = layoutTimeline([
      { id: "c", start: 1, end: 2 },
      { id: "a", start: 0, end: 1.5 },
      { id: "b", start: 1, end: 3 },
    ]);
    assert.deepEqual(rowsOf(result), { a: 0, b: 1, c: 2 });
  });

  it("is deterministic regardless of input order", () => {
    const items: TimelineItem[] = [
      { id: "a", start: 0, end: 5 },
      { id: "b", start: 1, end: 2 },
      { id: "c", start: 1, end: 3 },
      { id: "d", start: 4, end: 6 },
    ];
    const forward = layoutTimeline(items);
    const reverse = layoutTimeline([...items].reverse());
    assert.deepEqual(rowsOf(reverse), rowsOf(forward));
  });
});

describe("fixed rows", () => {
  it("honors fixed rows and grows the layout around them", () => {
    const result = layoutTimeline([
      { id: "pinned", start: 0, end: 2, fixedRow: 2 },
      { id: "a", start: 0, end: 1 },
      { id: "b", start: 1, end: 2 },
    ]);
    assert.equal(result.rowCount, 3);
    assert.equal(result.rows.get("pinned"), 2);
    assertLayoutValid(
      [
        { id: "pinned", start: 0, end: 2, fixedRow: 2 },
        { id: "a", start: 0, end: 1 },
        { id: "b", start: 1, end: 2 },
      ],
      result.rows
    );
  });

  it("rejects the whole batch on fixed conflicts", () => {
    const items: TimelineItem[] = [
      { id: "x", start: 0, end: 5, fixedRow: 1 },
      { id: "y", start: 3, end: 8, fixedRow: 1 },
      { id: "z", start: 100, end: 200 },
    ];
    assert.throws(() => layoutTimeline(items), (err: unknown) => {
      assert.ok(err instanceof FixedRowConflictError);
      assert.equal(err.conflicts.length, 1);
      assert.deepEqual(err.conflicts[0], { row: 1, firstId: "x", secondId: "y" });
      return true;
    });
  });

  it("reports every fixed conflict at once", () => {
    const items: TimelineItem[] = [
      { id: "x", start: 0, end: 5, fixedRow: 0 },
      { id: "y", start: 1, end: 2, fixedRow: 0 },
      { id: "p", start: 10, end: 20, fixedRow: 3 },
      { id: "q", start: 15, end: 30, fixedRow: 3 },
    ];
    assert.throws(
      () => layoutTimeline(items),
      (err: unknown) =>
        err instanceof FixedRowConflictError && err.conflicts.length === 2
    );
  });

  it("allows fixed rows on non-overlapping intervals", () => {
    const result = layoutTimeline([
      { id: "x", start: 0, end: 5, fixedRow: 1 },
      { id: "y", start: 5, end: 8, fixedRow: 1 },
    ]);
    assert.equal(result.rowCount, 2);
  });
});

describe("input validation", () => {
  it("rejects invalid items", () => {
    assert.throws(
      () => layoutTimeline([{ id: "a", start: 2, end: 2 }]),
      InvalidTimelineItemError
    );
    assert.throws(
      () => layoutTimeline([{ id: "a", start: 3, end: 2 }]),
      InvalidTimelineItemError
    );
    assert.throws(
      () => layoutTimeline([{ id: "a", start: 0, end: Number.NaN }]),
      InvalidTimelineItemError
    );
    assert.throws(
      () =>
        layoutTimeline([
          { id: "a", start: 0, end: 1 },
          { id: "a", start: 2, end: 3 },
        ]),
      InvalidTimelineItemError
    );
    assert.throws(
      () => layoutTimeline([{ id: "a", start: 0, end: 1, fixedRow: -1 }]),
      InvalidTimelineItemError
    );
    assert.throws(
      () => layoutTimeline([{ id: "a", start: 0, end: 1, fixedRow: 0.5 }]),
      InvalidTimelineItemError
    );
  });

  it("lays out an empty batch", () => {
    const result = layoutTimeline([]);
    assert.equal(result.rowCount, 0);
    assert.equal(result.rows.size, 0);
    assert.deepEqual(result.moves, []);
  });
});

describe("re-layout move deltas", () => {
  const initial: TimelineItem[] = [
    { id: "a", start: 0, end: 4 },
    { id: "b", start: 1, end: 2 },
    { id: "c", start: 3, end: 5 },
    { id: "e", start: 10, end: 11 },
  ];

  it("reports no moves for a fresh layout without a previous state", () => {
    assert.deepEqual(layoutTimeline(initial).moves, []);
  });

  it("reports moves, additions and removals against the previous layout", () => {
    const first = layoutTimeline(initial);
    assert.deepEqual(rowsOf(first), { a: 0, b: 1, c: 1, e: 0 });

    // b grows to overlap c, pushing c up a row; d is added; e is removed.
    const next = layoutTimeline(
      [
        { id: "a", start: 0, end: 4 },
        { id: "b", start: 1, end: 4 },
        { id: "c", start: 3, end: 5 },
        { id: "d", start: 0, end: 0.5 },
      ],
      first.rows
    );
    assert.deepEqual(rowsOf(next), { a: 0, d: 1, b: 1, c: 2 });
    assert.deepEqual(next.moves, [
      { id: "c", from: 1, to: 2 },
      { id: "d", from: null, to: 1 },
      { id: "e", from: 0, to: null },
    ]);
  });

  it("accepts a plain object as the previous layout", () => {
    const result = layoutTimeline([{ id: "a", start: 0, end: 1 }], {
      a: 0,
      gone: 2,
    });
    assert.deepEqual(result.moves, [{ id: "gone", from: 2, to: null }]);
  });
});

describe("minimum rows with fixed constraints", () => {
  it("rearranges when fixed rows push the greedy pass above the minimum", () => {
    // Greedy alone reaches 5 rows here; the true minimum is 4.
    const items: TimelineItem[] = [
      { id: "i0", start: 1, end: 4 },
      { id: "i1", start: 5, end: 6, fixedRow: 3 },
      { id: "i2", start: 2, end: 3 },
      { id: "i3", start: 0, end: 1 },
      { id: "i4", start: 4, end: 6, fixedRow: 2 },
      { id: "i5", start: 0, end: 4 },
      { id: "i6", start: 3, end: 6 },
    ];
    const result = layoutTimeline(items);
    assert.equal(result.rowCount, 4);
    assertLayoutValid(items, result.rows);
  });
});

describe("exhaustive minimum rows", () => {
  it("computes known minima", () => {
    assert.equal(minRowsExhaustive([]), 0);
    assert.equal(
      minRowsExhaustive([
        { id: "a", start: 0, end: 2 },
        { id: "b", start: 2, end: 4 },
      ]),
      1
    );
    assert.equal(
      minRowsExhaustive([
        { id: "a", start: 0, end: 3 },
        { id: "b", start: 1, end: 4 },
        { id: "c", start: 2, end: 5 },
      ]),
      3
    );
    // Fixed rows can force more rows than the overlap depth alone.
    assert.equal(
      minRowsExhaustive([
        { id: "x", start: 0, end: 10, fixedRow: 0 },
        { id: "a", start: 1, end: 2, fixedRow: 1 },
        { id: "b", start: 2, end: 3, fixedRow: 2 },
        { id: "y", start: 1, end: 3 },
      ]),
      4
    );
  });

  it("rejects fixed conflicts like the greedy layout", () => {
    assert.throws(
      () =>
        minRowsExhaustive([
          { id: "a", start: 0, end: 2, fixedRow: 0 },
          { id: "b", start: 1, end: 3, fixedRow: 0 },
        ]),
      FixedRowConflictError
    );
  });
});

describe("small instances: greedy matches exhaustive minimum", () => {
  // Deterministic PRNG (mulberry32) so the run is reproducible.
  function rng(seed: number) {
    let state = seed >>> 0;
    return () => {
      state = (state + 0x6d2b79f5) >>> 0;
      let t = state;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  function randomItems(random: () => number, count: number): TimelineItem[] {
    const items: TimelineItem[] = [];
    for (let i = 0; i < count; i++) {
      const start = Math.floor(random() * 8);
      const end = start + 1 + Math.floor(random() * 5);
      const item: TimelineItem = { id: `i${i}`, start, end };
      if (random() < 0.35) {
        item.fixedRow = Math.floor(random() * 4);
      }
      items.push(item);
    }
    return items;
  }

  it("greedy row count equals the exhaustive minimum on random batches", () => {
    const random = rng(20261007);
    let feasibleBatches = 0;
    for (let trial = 0; trial < 2000; trial++) {
      const items = randomItems(random, Math.floor(random() * 8));
      let expected: number;
      try {
        expected = minRowsExhaustive(items);
      } catch (err) {
        assert.ok(err instanceof FixedRowConflictError);
        assert.throws(() => layoutTimeline(items), FixedRowConflictError);
        continue;
      }
      feasibleBatches++;
      const result = layoutTimeline(items);
      assertLayoutValid(items, result.rows);
      assert.equal(
        result.rowCount,
        expected,
        `row count mismatch for ${JSON.stringify(items)}`
      );
    }
    assert.ok(feasibleBatches > 0, "expected some feasible batches");
  });
});
