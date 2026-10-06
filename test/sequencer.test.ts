import { test } from "node:test";
import assert from "node:assert/strict";
import { Rational } from "../src/rational.ts";
import { TempoMap } from "../src/tempo-map.ts";
import { Sequencer } from "../src/sequencer.ts";

test("editing tempo segments never moves event ticks", () => {
  const slow = TempoMap.fromBpm(480, [{ tick: 0, bpm: Rational.of(60) }]);
  const seq = new Sequencer<string>(slow);
  seq.addEvent(0, "a");
  seq.addEvent(480, "b");
  seq.addEvent(960, "c");

  const before = seq.getTimedEvents().map((e) => e.microseconds);
  assert.deepEqual(before, [0, 1_000_000, 2_000_000]);

  // Edit: add a segment and change tempi. Ticks must stay put.
  const edited = TempoMap.fromBpm(480, [
    { tick: 0, bpm: Rational.of(120) },
    { tick: 480, bpm: Rational.of(90) },
  ]);
  seq.setTempoMap(edited);

  assert.deepEqual(seq.getEvents().map((e) => e.tick), [0, 480, 960]);
  const after = seq.getTimedEvents().map((e) => e.microseconds);
  assert.equal(after[0], 0);
  assert.equal(after[1], 500_000); // 480 ticks at 120 BPM
  // 960 ticks: 500000 + 480 * (60_000_000 / (90*480)) = 500000 + 666666.67 -> half-even
  assert.equal(after[2], 1_166_667);
  assert.notDeepEqual(after, before);
});

test("events are kept sorted by tick", () => {
  const map = new TempoMap([{ startTick: 0, microsecondsPerTick: Rational.of(1000) }]);
  const seq = new Sequencer<number>(map);
  seq.addEvent(100, 1);
  seq.addEvent(5, 2);
  seq.addEvent(42, 3);
  assert.deepEqual(seq.getEvents().map((e) => e.tick), [5, 42, 100]);
});
