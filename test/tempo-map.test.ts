import { test } from "node:test";
import assert from "node:assert/strict";
import { Rational, roundHalfEven } from "../src/rational.ts";
import { TempoMap, type TempoSegment } from "../src/tempo-map.ts";

/**
 * Independent naive reference: walk segments in order, accumulate exact
 * rational time tick-span by tick-span. Used to validate the map's
 * precomputed boundaries and per-tick integration.
 */
function referenceTimeAt(segments: readonly TempoSegment[], tick: number): Rational {
  const sorted = [...segments].sort((a, b) => a.startTick - b.startTick);
  let time = Rational.of(0);
  let cursor = 0;
  for (let i = 0; i < sorted.length; i++) {
    const seg = sorted[i]!;
    const end = i + 1 < sorted.length ? sorted[i + 1]!.startTick : Infinity;
    const target = Math.min(tick, end);
    if (target > cursor) {
      time = time.add(seg.microsecondsPerTick.mul(Rational.of(target - cursor)));
      cursor = target;
    }
    if (cursor >= tick) break;
  }
  return time;
}

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

function randomMap(rand: () => number): { map: TempoMap; segments: TempoSegment[] } {
  const count = 1 + Math.floor(rand() * 5);
  const segments: TempoSegment[] = [];
  let tick = 0;
  for (let i = 0; i < count; i++) {
    segments.push({
      startTick: tick,
      microsecondsPerTick: Rational.of(1 + Math.floor(rand() * 5000), 1 + Math.floor(rand() * 97)),
    });
    tick += 1 + Math.floor(rand() * 500);
  }
  return { map: new TempoMap(segments), segments };
}

test("exact integration across segment boundaries", () => {
  // 120 BPM at 480 PPQ: 500000/480 = 3125/3 us per tick.
  const map = TempoMap.fromBpm(480, [
    { tick: 0, bpm: Rational.of(120) },
    { tick: 960, bpm: Rational.of(60) },
  ]);
  assert.ok(map.timeAt(960).equals(Rational.of(1_000_000))); // 960 * 3125/3 exactly
  assert.ok(map.timeAt(961).equals(Rational.of(1_000_000).add(Rational.of(6250, 3))));
  assert.equal(map.tickToMicroseconds(960), 1_000_000);
  // 60 BPM at 480 PPQ: 6250/3 us per tick; boundary at 960+480=1440 -> 2,000,000 exactly.
  assert.ok(map.timeAt(1440).equals(Rational.of(2_000_000)));
});

test("round-half-even applied once at the end", () => {
  // 1/2 us per tick: tick 5 -> exactly 2.5 us -> ties to even -> 2.
  const map = new TempoMap([{ startTick: 0, microsecondsPerTick: Rational.of(1, 2) }]);
  assert.equal(map.tickToMicroseconds(5), 2);
  assert.equal(map.tickToMicroseconds(7), 4); // 3.5 -> 4
  assert.equal(map.tickToMicroseconds(4), 2);
  // Segment boundary landing exactly on x.5 must round half-even, not accumulate floats.
  const map2 = new TempoMap([
    { startTick: 0, microsecondsPerTick: Rational.of(1, 4) },
    { startTick: 10, microsecondsPerTick: Rational.of(1, 4) },
  ]);
  // tick 10 -> 2.5 -> 2 (even), tick 30 -> 7.5 -> 8 (even)
  assert.equal(map2.tickToMicroseconds(10), 2);
  assert.equal(map2.tickToMicroseconds(30), 8);
});

test("boundaries and per-tick times match rational reference", () => {
  const rand = mulberry32(42);
  for (let trial = 0; trial < 50; trial++) {
    const { map, segments } = randomMap(rand);
    for (const seg of segments) {
      assert.ok(
        map.timeAt(seg.startTick).equals(referenceTimeAt(segments, seg.startTick)),
        `boundary at tick ${seg.startTick}`,
      );
    }
    for (let t = 0; t < 200; t += 7) {
      assert.ok(map.timeAt(t).equals(referenceTimeAt(segments, t)), `tick ${t}`);
    }
  }
});

test("strict monotonicity of exact and rounded times", () => {
  const rand = mulberry32(7);
  for (let trial = 0; trial < 30; trial++) {
    const { map } = randomMap(rand);
    let prevExact = map.timeAt(0);
    let prevRounded = map.tickToMicroseconds(0);
    for (let t = 1; t <= 300; t++) {
      const exact = map.timeAt(t);
      assert.ok(exact.cmp(prevExact) > 0, `exact time not increasing at tick ${t}`);
      const rounded = map.tickToMicroseconds(t);
      assert.ok(rounded >= prevRounded, `rounded time not monotone at tick ${t}`);
      assert.equal(rounded, Number(roundHalfEven(exact)));
      prevExact = exact;
      prevRounded = rounded;
    }
  }
});

test("reverse lookup returns earliest tick with exact time >= target", () => {
  const rand = mulberry32(99);
  for (let trial = 0; trial < 30; trial++) {
    const { map } = randomMap(rand);
    for (let t = 0; t < 400; t += 3) {
      const us = map.tickToMicroseconds(t);
      const back = map.microsecondsToTick(us);
      // Earliest tick whose exact time reaches us.
      assert.ok(map.timeAt(back).cmp(Rational.of(us)) >= 0, `time(${back}) < ${us}`);
      if (back > 0) {
        assert.ok(map.timeAt(back - 1).cmp(Rational.of(us)) < 0, `time(${back - 1}) >= ${us}`);
      }
    }
  }
});

test("reverse lookup is exact at segment boundaries", () => {
  const map = TempoMap.fromBpm(480, [
    { tick: 0, bpm: Rational.of(120) },
    { tick: 960, bpm: Rational.of(60) },
  ]);
  assert.equal(map.microsecondsToTick(1_000_000), 960);
  assert.equal(map.microsecondsToTick(2_000_000), 1440);
  assert.equal(map.microsecondsToTick(999_999), 960); // 959 -> 999999.33... < 999999? no: check exactly
  assert.equal(map.microsecondsToTick(0), 0);
  assert.equal(map.microsecondsToTick(-5), 0);
});

test("validation rejects bad maps", () => {
  assert.throws(() => new TempoMap([]));
  assert.throws(() => new TempoMap([{ startTick: 1, microsecondsPerTick: Rational.of(1) }]));
  assert.throws(() => new TempoMap([{ startTick: 0, microsecondsPerTick: Rational.of(0) }]));
  assert.throws(() => new TempoMap([{ startTick: 0, microsecondsPerTick: Rational.of(-1) }]));
});
