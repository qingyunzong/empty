import { test } from "node:test";
import assert from "node:assert/strict";
import { Rational } from "../src/rational.js";
import { TempoMap } from "../src/tempo-map.js";
import { Sequencer } from "../src/sequencer.js";
import {
  mulberry32,
  refExactTime,
  refRoundHalfEven,
  refTickToUs,
  type RefSegment,
} from "./reference.js";

function buildMap(segs: readonly RefSegment[]): TempoMap {
  const map = new TempoMap(Rational.of(segs[0]!.num, segs[0]!.den));
  for (const s of segs.slice(1)) {
    map.setTempo(s.tick, Rational.of(s.num, s.den));
  }
  return map;
}

function randomMap(rand: () => number, segmentCount: number, span: number): RefSegment[] {
  const segs: RefSegment[] = [{ tick: 0, num: 1n + BigInt(Math.floor(rand() * 500)), den: 1n + BigInt(Math.floor(rand() * 60)) }];
  let tick = 0;
  for (let i = 1; i < segmentCount; i++) {
    tick += 1 + Math.floor(rand() * 40);
    segs.push({ tick, num: 1n + BigInt(Math.floor(rand() * 500)), den: 1n + BigInt(Math.floor(rand() * 60)) });
  }
  void span;
  return segs;
}

test("single segment converts exactly with one final rounding", () => {
  const map = new TempoMap(Rational.of(1n, 3n)); // 1/3 us per tick
  assert.equal(map.tickToUs(0), 0n);
  assert.equal(map.tickToUs(1), 0n); // 1/3 -> 0
  assert.equal(map.tickToUs(2), 1n); // 2/3 -> 1
  assert.equal(map.tickToUs(3), 1n); // exactly 1
  assert.equal(map.tickToRational(3).toString(), "1");
});

test("rounding happens once at the end, never per segment", () => {
  // Two segments of 1/2 us/tick, one tick each.
  // Per-segment rounding would give round(1/2)+round(1/2) = 0+0 = 0.
  // Exact integral is 1, so the single final rounding must give 1.
  const map = buildMap([
    { tick: 0, num: 1n, den: 2n },
    { tick: 1, num: 1n, den: 2n },
  ]);
  assert.equal(map.tickToUs(2), 1n);
  assert.equal(map.tickToRational(2).toString(), "1");
});

test("matches rational reference on hand-picked segment boundaries", () => {
  const segs: RefSegment[] = [
    { tick: 0, num: 1n, den: 3n },
    { tick: 5, num: 7n, den: 2n },
    { tick: 9, num: 2n, den: 7n },
    { tick: 40, num: 11n, den: 1n },
  ];
  const map = buildMap(segs);
  for (let tick = 0; tick <= 120; tick++) {
    assert.equal(map.tickToUs(tick), refTickToUs(segs, tick), `tick ${tick}`);
    const exact = map.tickToRational(tick);
    const ref = refExactTime(segs, tick);
    assert.equal(exact.num * ref.d, ref.n * exact.den, `exact tick ${tick}`);
  }
});

test("boundary ticks are continuous and use the new rate only after the boundary", () => {
  const segs: RefSegment[] = [
    { tick: 0, num: 3n, den: 2n },
    { tick: 10, num: 1n, den: 5n },
  ];
  const map = buildMap(segs);
  // Time at the boundary equals the exact integral of the first segment.
  assert.equal(map.tickToRational(10).toString(), "15");
  // One tick before/after the boundary moves by the old/new rate exactly.
  assert.equal(map.tickToRational(10).sub(map.tickToRational(9)).toString(), "3/2");
  assert.equal(map.tickToRational(11).sub(map.tickToRational(10)).toString(), "1/5");
  assert.equal(map.tickToUs(10), refRoundHalfEven({ n: 15n, d: 1n }));
});

test("monotonicity: exact time strictly increases, rounded time never decreases", () => {
  const rand = mulberry32(12345);
  for (let trial = 0; trial < 20; trial++) {
    const segs = randomMap(rand, 1 + Math.floor(rand() * 8), 0);
    const map = buildMap(segs);
    const maxTick = segs[segs.length - 1]!.tick + 50;
    let prevExact = map.tickToRational(0);
    let prevUs = map.tickToUs(0);
    for (let tick = 1; tick <= maxTick; tick++) {
      const exact = map.tickToRational(tick);
      const us = map.tickToUs(tick);
      assert.ok(exact.cmp(prevExact) > 0, `strictly increasing at tick ${tick}`);
      assert.ok(us >= prevUs, `non-decreasing rounded at tick ${tick}`);
      assert.equal(us, refTickToUs(segs, tick), `reference match at tick ${tick}`);
      prevExact = exact;
      prevUs = us;
    }
  }
});

test("usToTick returns the earliest tick reaching the given microseconds", () => {
  const map = new TempoMap(Rational.of(1n, 2n)); // rounded: 0,0,1,2,2,2,3,...
  assert.equal(map.usToTick(0n), 0);
  assert.equal(map.usToTick(1n), 2); // tick 2 is the first with time 1
  assert.equal(map.usToTick(2n), 3); // round(3/2)=2, tick 3 earliest
  assert.equal(map.usToTick(3n), 6);
  assert.equal(map.usToTick(-5n), 0);
});

test("usToTick inverts tickToUs as tightly as rounding allows", () => {
  const rand = mulberry32(999);
  for (let trial = 0; trial < 15; trial++) {
    const segs = randomMap(rand, 1 + Math.floor(rand() * 6), 0);
    const map = buildMap(segs);
    const maxTick = segs[segs.length - 1]!.tick + 30;
    for (let i = 0; i < 60; i++) {
      const tick = Math.floor(rand() * maxTick);
      const us = map.tickToUs(tick);
      const back = map.usToTick(us);
      assert.ok(back <= tick, "reverse never overshoots the source tick");
      assert.equal(map.tickToUs(back), us, "reverse lands on the same rounded time");
      if (back > 0) assert.ok(map.tickToUs(back - 1) < us, "reverse is the earliest such tick");
    }
    // Arbitrary microsecond targets: first tick at or after the target.
    for (let i = 0; i < 60; i++) {
      const us = BigInt(Math.floor(rand() * 2000));
      const t = map.usToTick(us);
      assert.ok(map.tickToUs(t) >= us);
      if (t > 0) assert.ok(map.tickToUs(t - 1) < us);
    }
  }
});

test("editing segments replaces, inserts in order, and removes cleanly", () => {
  const map = new TempoMap(Rational.of(1n, 1n));
  map.setTempo(10, Rational.of(2n, 1n));
  map.setTempo(5, Rational.of(3n, 1n));
  assert.deepEqual(map.segments.map((s) => s.tick), [0, 5, 10]);
  map.setTempo(5, Rational.of(4n, 1n)); // replace in place
  assert.deepEqual(
    map.segments.map((s) => [s.tick, s.usPerTick.toString()]),
    [
      [0, "1"],
      [5, "4"],
      [10, "2"],
    ],
  );
  assert.equal(map.tickToRational(10).toString(), "25"); // 5*1 + 5*4
  assert.equal(map.removeTempo(5), true);
  assert.equal(map.tickToRational(10).toString(), "10"); // back to 1 us/tick
  assert.equal(map.removeTempo(0), false);
  assert.equal(map.removeTempo(42), false);
});

test("editing tempo segments never moves event ticks", () => {
  const seq = new Sequencer<string>(Rational.of(500n, 1n));
  seq.addEvent(240, "a");
  seq.addEvent(0, "b");
  seq.addEvent(100, "c");
  const before = seq.events.map((e) => [e.tick, seq.eventTimeUs(e)] as const);
  assert.deepEqual(before, [
    [0, 0n],
    [100, 50000n],
    [240, 120000n],
  ]);
  seq.tempoMap.setTempo(50, Rational.of(1000n, 3n));
  seq.tempoMap.setTempo(200, Rational.of(1n, 4n));
  // Ticks are untouched; only derived times change.
  assert.deepEqual(
    seq.events.map((e) => e.tick),
    [0, 100, 240],
  );
  assert.equal(seq.eventTimeUs(seq.events[1]!), seq.tempoMap.tickToUs(100));
  assert.equal(seq.eventTimeUs(seq.events[2]!), seq.tempoMap.tickToUs(240));
  // And the new times still match the rational reference.
  const segs: RefSegment[] = [
    { tick: 0, num: 500n, den: 1n },
    { tick: 50, num: 1000n, den: 3n },
    { tick: 200, num: 1n, den: 4n },
  ];
  for (const e of seq.events) {
    assert.equal(seq.eventTimeUs(e), refTickToUs(segs, e.tick));
  }
});

test("rejects invalid ticks and non-positive rates", () => {
  assert.throws(() => new TempoMap(Rational.of(0n, 1n)));
  assert.throws(() => new TempoMap(Rational.of(-1n, 2n)));
  const map = new TempoMap(Rational.of(1n, 1n));
  assert.throws(() => map.setTempo(-1, Rational.of(1n, 1n)));
  assert.throws(() => map.setTempo(1.5, Rational.of(1n, 1n)));
  assert.throws(() => map.tickToUs(-3));
  assert.throws(() => map.tickToUs(Number.NaN));
});
