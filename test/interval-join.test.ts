import { test } from "node:test";
import { deepEqual, equal, ok } from "node:assert/strict";
import {
  IntervalJoin,
  offlineJoin,
  type IntervalEvent,
  type JoinResult,
} from "../src/interval-join.js";

test("emits non-empty intersections with source ids", () => {
  const join = new IntervalJoin();

  const first = join.pushLeft({ id: "L1", start: 0, end: 10 });
  equal(first.status, "ok");
  deepEqual(first.emitted, []);

  const overlap = join.pushRight({ id: "R1", start: 5, end: 15 });
  equal(overlap.status, "ok");
  deepEqual(overlap.emitted, [
    { leftId: "L1", rightId: "R1", start: 5, end: 10 },
  ]);

  // Half-open intervals: touching at a boundary is NOT an intersection.
  const touching = join.pushRight({ id: "R2", start: 10, end: 20 });
  equal(touching.status, "ok");
  deepEqual(touching.emitted, []);

  const contained = join.pushRight({ id: "R3", start: 0, end: 1 });
  deepEqual(contained.emitted, [
    { leftId: "L1", rightId: "R3", start: 0, end: 1 },
  ]);
});

test("out-of-order arrival across sides still joins", () => {
  const join = new IntervalJoin();
  join.pushRight({ id: "R1", start: 3, end: 7 });
  const outcome = join.pushLeft({ id: "L1", start: 0, end: 5 });
  deepEqual(outcome.emitted, [
    { leftId: "L1", rightId: "R1", start: 3, end: 5 },
  ]);
});

test("watermark reclaims exactly the items that can no longer match", () => {
  const join = new IntervalJoin();
  join.pushLeft({ id: "L1", start: 0, end: 4 });
  join.pushLeft({ id: "L2", start: 4, end: 12 });
  join.pushRight({ id: "R1", start: 1, end: 2 });
  equal(join.bufferedCount, 3);

  // L1 (end 4) and R1 (end 2) can never match events starting at >= 4.
  equal(join.advanceWatermark(4), 2);
  equal(join.bufferedCount, 1);
  equal(join.reclaimedCount, 2);

  // Stale / non-monotonic watermarks are ignored.
  equal(join.advanceWatermark(3), 0);
  equal(join.currentWatermark, 4);

  // Survivor still joins with new arrivals.
  const outcome = join.pushRight({ id: "R2", start: 5, end: 6 });
  deepEqual(outcome.emitted, [
    { leftId: "L2", rightId: "R2", start: 5, end: 6 },
  ]);
});

test("events later than the watermark are rejected", () => {
  const join = new IntervalJoin();
  join.pushLeft({ id: "L1", start: 10, end: 20 });
  join.advanceWatermark(10);

  const late = join.pushRight({ id: "R1", start: 5, end: 15 });
  equal(late.status, "late");
  deepEqual(late.emitted, []);
  equal(join.bufferedCount, 1);

  // Boundary: start == watermark is still admissible.
  const onTime = join.pushRight({ id: "R2", start: 10, end: 12 });
  equal(onTime.status, "ok");
  deepEqual(onTime.emitted, [
    { leftId: "L1", rightId: "R2", start: 10, end: 12 },
  ]);
});

test("resident-item limit applies backpressure until reclamation frees space", () => {
  const join = new IntervalJoin({ maxBuffered: 2 });
  equal(join.pushLeft({ id: "L1", start: 0, end: 5 }).status, "ok");
  equal(join.pushRight({ id: "R1", start: 1, end: 2 }).status, "ok");

  const blocked = join.pushLeft({ id: "L2", start: 5, end: 9 });
  equal(blocked.status, "backpressure");
  deepEqual(blocked.emitted, []);
  equal(join.bufferedCount, 2);

  // Watermark reclaims L1 (end 5 <= 5) and R1 (end 2 <= 5); the blocked
  // push is still admissible (start 5 >= watermark 5) and now succeeds.
  equal(join.advanceWatermark(5), 2);
  equal(join.pushLeft({ id: "L2", start: 5, end: 9 }).status, "ok");
  equal(join.bufferedCount, 1);
});

test("malformed intervals and duplicate resident ids are rejected", () => {
  const join = new IntervalJoin();
  equal(join.pushLeft({ id: "bad", start: 5, end: 5 }).status, "invalid");
  equal(join.pushLeft({ id: "bad", start: 6, end: 5 }).status, "invalid");
  equal(
    join.pushLeft({ id: "bad", start: 0, end: Number.NaN }).status,
    "invalid",
  );
  equal(join.pushLeft({ id: "", start: 0, end: 1 }).status, "invalid");
  equal(join.bufferedCount, 0);

  equal(join.pushLeft({ id: "L1", start: 0, end: 1 }).status, "ok");
  equal(join.pushLeft({ id: "L1", start: 2, end: 3 }).status, "invalid");
});

test("streaming output equals offline full pairing under disorder, watermarks and backpressure", () => {
  for (const seed of [7, 42, 1337]) {
    const rng = mulberry32(seed);
    const arrivals = shuffle(
      [
        ...generateEvents("L", 120, rng).map((event) => ({
          side: "left" as const,
          event,
        })),
        ...generateEvents("R", 120, rng).map((event) => ({
          side: "right" as const,
          event,
        })),
      ],
      rng,
    );

    const join = new IntervalJoin({ maxBuffered: 40 });
    const acceptedLeft: IntervalEvent[] = [];
    const acceptedRight: IntervalEvent[] = [];
    const emitted: JoinResult[] = [];
    const queue = [...arrivals];
    let sinceWatermark = 0;

    while (queue.length > 0) {
      const { side, event } = queue[0]!;

      // Randomly advance the watermark, possibly past some pending starts
      // (those pushes will be rejected as late and excluded from the reference).
      if (sinceWatermark >= 5 && rng() < 0.5) {
        const minPending = Math.min(...queue.map((a) => a.event.start));
        join.advanceWatermark(minPending + Math.floor(rng() * 30));
        sinceWatermark = 0;
      }

      const outcome =
        side === "left" ? join.pushLeft(event) : join.pushRight(event);

      if (outcome.status === "backpressure") {
        // Free space by bumping the watermark until something is reclaimed.
        let candidate = Math.min(...queue.map((a) => a.event.start));
        while (join.advanceWatermark(candidate) === 0) {
          candidate += 1;
        }
        continue; // retry the same event
      }

      queue.shift();
      sinceWatermark += 1;
      if (outcome.status === "ok") {
        (side === "left" ? acceptedLeft : acceptedRight).push(event);
        emitted.push(...outcome.emitted);
      } else {
        equal(outcome.status, "late");
      }
    }

    // Equivalence with the offline full pairing of exactly the accepted events.
    const expected = offlineJoin(acceptedLeft, acceptedRight);
    equal(emitted.length, expected.length, `seed ${seed}: result count`);
    deepEqual(
      sortResults(emitted),
      sortResults(expected),
      `seed ${seed}: result sets`,
    );

    // Each pair is emitted at most once.
    const pairKeys = new Set(emitted.map((r) => `${r.leftId} ${r.rightId}`));
    equal(pairKeys.size, emitted.length, `seed ${seed}: no duplicate pairs`);

    // Every emitted intersection is genuinely non-empty.
    for (const result of emitted) {
      ok(result.start < result.end, `seed ${seed}: non-empty intersection`);
    }
  }
});

function generateEvents(
  prefix: string,
  count: number,
  rng: () => number,
): IntervalEvent[] {
  const events: IntervalEvent[] = [];
  for (let i = 0; i < count; i += 1) {
    const start = Math.floor(rng() * 1000);
    const duration = 1 + Math.floor(rng() * 40);
    events.push({ id: `${prefix}${i}`, start, end: start + duration });
  }
  return events;
}

function sortResults(results: readonly JoinResult[]): JoinResult[] {
  return [...results].sort(
    (a, b) =>
      a.leftId.localeCompare(b.leftId) ||
      a.rightId.localeCompare(b.rightId) ||
      a.start - b.start ||
      a.end - b.end,
  );
}

function shuffle<T>(items: T[], rng: () => number): T[] {
  const copy = [...items];
  for (let i = copy.length - 1; i > 0; i -= 1) {
    const j = Math.floor(rng() * (i + 1));
    [copy[i], copy[j]] = [copy[j]!, copy[i]!];
  }
  return copy;
}

function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
