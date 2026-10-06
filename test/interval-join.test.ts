import { test } from "node:test";
import * as assert from "node:assert/strict";
import {
  IntervalJoin,
  fullPairwiseJoin,
  type IntervalEvent,
  type JoinMatch,
  type Side,
} from "../src/interval-join.js";

function ev(id: string, start: number, end: number): IntervalEvent {
  return { id, start, end };
}

function sortMatches(matches: readonly JoinMatch[]): JoinMatch[] {
  return [...matches].sort(
    (a, b) =>
      a.leftId.localeCompare(b.leftId) ||
      a.rightId.localeCompare(b.rightId) ||
      a.start - b.start ||
      a.end - b.end,
  );
}

test("emits all non-empty intersections with source ids and exact bounds", () => {
  const join = new IntervalJoin({ leftCapacity: 10, rightCapacity: 10 });
  const all: JoinMatch[] = [];

  all.push(...join.push("left", ev("L1", 0, 10)).matches);
  all.push(...join.push("left", ev("L2", 5, 7)).matches);
  all.push(...join.push("right", ev("R1", 3, 6)).matches); // overlaps L1, L2
  all.push(...join.push("right", ev("R2", 10, 20)).matches); // touches L1 at 10 -> empty
  all.push(...join.push("right", ev("R3", -5, 0)).matches); // touches L1 at 0 -> empty

  assert.deepEqual(sortMatches(all), [
    { leftId: "L1", rightId: "R1", start: 3, end: 6 },
    { leftId: "L2", rightId: "R1", start: 5, end: 6 },
  ]);
});

test("half-open boundaries: touching intervals never match", () => {
  const join = new IntervalJoin({ leftCapacity: 4, rightCapacity: 4 });
  join.push("left", ev("L", 0, 5));
  const result = join.push("right", ev("R", 5, 9));
  assert.equal(result.status, "accepted");
  assert.deepEqual(result.matches, []);
});

test("rejects invalid (empty/inverted) intervals", () => {
  const join = new IntervalJoin({ leftCapacity: 4, rightCapacity: 4 });
  assert.equal(join.push("left", ev("bad1", 5, 5)).status, "invalid");
  assert.equal(join.push("right", ev("bad2", 9, 4)).status, "invalid");
  assert.equal(join.size("left"), 0);
  assert.equal(join.size("right"), 0);
});

test("events behind the watermark are rejected as late", () => {
  const join = new IntervalJoin({ leftCapacity: 4, rightCapacity: 4 });
  join.push("left", ev("L1", 10, 20));
  join.advanceWatermark("left", 10);

  assert.equal(join.push("left", ev("L2", 9, 30)).status, "late"); // 9 < 10
  assert.equal(join.push("left", ev("L3", 10, 30)).status, "accepted"); // at watermark: ok
  // The other side has its own watermark and is unaffected.
  assert.equal(join.push("right", ev("R1", 0, 30)).status, "accepted");
});

test("watermark evicts only opposite-side items that can never match again", () => {
  const join = new IntervalJoin({ leftCapacity: 8, rightCapacity: 8 });
  join.push("left", ev("L1", 0, 5));
  join.push("left", ev("L2", 0, 10));
  join.push("right", ev("R1", 0, 3));
  join.push("right", ev("R2", 0, 7));

  // Left watermark to 5: right items with end <= 5 can never match a future
  // left event (start >= 5), so R1 is evicted; R2 (end 7) stays.
  const evicted = join.advanceWatermark("left", 5);
  assert.deepEqual(evicted.map((e) => e.id), ["R1"]);
  assert.equal(join.size("right"), 1);
  assert.equal(join.size("left"), 2); // left buffer untouched by left watermark

  // Watermarks are monotone: re-advancing to a lower value is a no-op.
  assert.deepEqual(join.advanceWatermark("left", 4), []);
  assert.equal(join.watermark("left"), 5);

  // A future left event still matches the retained R2, and (per half-open
  // semantics) correctly does not match the evicted R1 anyway.
  const result = join.push("left", ev("L3", 5, 8));
  assert.deepEqual(result.matches, [
    { leftId: "L3", rightId: "R2", start: 5, end: 7 },
  ]);
});

test("bounded buffer applies backpressure; eviction relieves it", () => {
  const join = new IntervalJoin({ leftCapacity: 2, rightCapacity: 1 });
  assert.equal(join.push("left", ev("L1", 0, 4)).status, "accepted");
  assert.equal(join.push("left", ev("L2", 1, 3)).status, "accepted");

  // Full: the event is NOT consumed and must be retried by the caller.
  assert.equal(join.push("left", ev("L3", 2, 9)).status, "full");
  assert.equal(join.size("left"), 2);

  // Right watermark 4 evicts left items with end <= 4 (both L1 and L2).
  const evicted = join.advanceWatermark("right", 4);
  assert.deepEqual(evicted.map((e) => e.id), ["L1", "L2"]);
  assert.equal(join.size("left"), 0);

  // Retry now succeeds (and right-side events at start >= 4 cannot overlap
  // the evicted items, so no match is lost).
  assert.equal(join.push("left", ev("L3", 2, 9)).status, "accepted");
});

test("pushAsync waits out backpressure until a watermark frees capacity", async () => {
  const join = new IntervalJoin({ leftCapacity: 1, rightCapacity: 1 });
  join.push("left", ev("L1", 0, 10));

  let settled = false;
  const pending = join
    .pushAsync("left", ev("L2", 5, 12))
    .then((r) => {
      settled = true;
      return r;
    });

  await new Promise((r) => setTimeout(r, 20));
  assert.equal(settled, false); // still blocked on full buffer

  join.advanceWatermark("right", 10); // evicts L1 (end 10 <= 10)
  const result = await pending;
  assert.equal(settled, true);
  assert.equal(result.status, "accepted");
  assert.equal(join.size("left"), 1);
});

// Deterministic PRNG so failures are reproducible.
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

test("randomized out-of-order stream matches offline full-pairwise reference", () => {
  for (let seed = 1; seed <= 25; seed++) {
    const rand = mulberry32(seed);
    const join = new IntervalJoin({ leftCapacity: 500, rightCapacity: 500 });

    const arrivals: Array<{ side: Side; event: IntervalEvent }> = [];
    for (const side of ["left", "right"] as const) {
      for (let i = 0; i < 60; i++) {
        const start = Math.floor(rand() * 200);
        const end = start + 1 + Math.floor(rand() * 20);
        arrivals.push({ side, event: ev(`${side}-${i}`, start, end) });
      }
    }
    // Shuffle to force out-of-order, interleaved arrival across both sides.
    for (let i = arrivals.length - 1; i > 0; i--) {
      const j = Math.floor(rand() * (i + 1));
      [arrivals[i], arrivals[j]] = [arrivals[j]!, arrivals[i]!];
    }

    const watermarks: Record<Side, number> = {
      left: Number.NEGATIVE_INFINITY,
      right: Number.NEGATIVE_INFINITY,
    };
    const accepted: Record<Side, IntervalEvent[]> = { left: [], right: [] };
    const streamed: JoinMatch[] = [];

    for (const { side, event } of arrivals) {
      // Randomly advance this side's watermark, but never past the smallest
      // start we might still want to accept, so lateness also occurs naturally.
      if (rand() < 0.15) {
        const target = watermarks[side] + Math.floor(rand() * 30);
        join.advanceWatermark(side, target);
        watermarks[side] = Math.max(watermarks[side], target);
      }
      const result = join.push(side, event);
      assert.notEqual(result.status, "full", "capacity must suffice in this test");
      if (result.status === "accepted") {
        accepted[side].push(event);
        streamed.push(...result.matches);
      } else {
        assert.equal(result.status, "late");
        assert.ok(event.start < watermarks[side]);
      }
    }

    const reference = fullPairwiseJoin(accepted.left, accepted.right);
    assert.deepEqual(
      sortMatches(streamed),
      sortMatches(reference),
      `seed ${seed}: streaming join diverged from offline reference`,
    );

    // Invariant: everything still retained can match some future event, i.e.
    // its end is beyond the opposite side's watermark.
    for (const e of accepted.left) {
      if (join.has("left", e.id)) {
        assert.ok(
          e.end > watermarks.right,
          `seed ${seed}: ${e.id} retained although it can never match again`,
        );
      }
    }
    for (const e of accepted.right) {
      if (join.has("right", e.id)) {
        assert.ok(
          e.end > watermarks.left,
          `seed ${seed}: ${e.id} retained although it can never match again`,
        );
      }
    }

    // Terminal watermarks reclaim all remaining state.
    join.advanceWatermark("left", Number.POSITIVE_INFINITY);
    join.advanceWatermark("right", Number.POSITIVE_INFINITY);
    assert.equal(join.size("left"), 0);
    assert.equal(join.size("right"), 0);
  }
});

test("state retained exactly while it can still match future events", () => {
  const join = new IntervalJoin({ leftCapacity: 16, rightCapacity: 16 });
  join.push("left", ev("L1", 0, 100)); // long-lived
  join.push("left", ev("L2", 0, 2)); // short-lived

  join.advanceWatermark("right", 50);
  assert.equal(join.size("left"), 1); // L2 evicted, L1 retained

  // Late right event behind the right watermark is rejected...
  assert.equal(join.push("right", ev("R-late", 10, 60)).status, "late");
  // ...while an on-time one still matches the retained long interval.
  const result = join.push("right", ev("R1", 50, 60));
  assert.deepEqual(result.matches, [
    { leftId: "L1", rightId: "R1", start: 50, end: 60 },
  ]);
});
