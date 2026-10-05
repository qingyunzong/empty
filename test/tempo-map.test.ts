import { test } from "node:test";
import assert from "node:assert/strict";
import { Rational } from "../src/rational";
import { TempoMap } from "../src/tempo-map";
import { Score } from "../src/score";

test("constant tempo maps beats to rational ms", () => {
  const map = TempoMap.fromBpm(Rational.of(120)); // 500 ms/beat
  assert.equal(map.beatToMs(Rational.of(0)).toString(), "0");
  assert.equal(map.beatToMs(Rational.of(1)).toString(), "500");
  assert.equal(map.beatToMs(Rational.of(1, 3)).toString(), "500/3");
});

test("multi-segment tempo map accumulates exact rational ms", () => {
  const map = TempoMap.fromBpm(Rational.of(120)); // 500 ms/beat
  map.setTempo(Rational.of(2), Rational.of(60000).div(Rational.of(90))); // 2000/3 ms/beat
  map.setTempo(Rational.of(3), Rational.of(60000).div(Rational.of(150))); // 400 ms/beat

  assert.equal(map.beatToMs(Rational.of(2)).toString(), "1000");
  // beat 5/2: 1000 + (1/2)*(2000/3) = 1000 + 1000/3 = 4000/3
  assert.equal(map.beatToMs(Rational.of(5, 2)).toString(), "4000/3");
  // beat 3: 1000 + 2000/3 = 5000/3
  assert.equal(map.beatToMs(Rational.of(3)).toString(), "5000/3");
  // beat 4: 5000/3 + 400 = 6200/3
  assert.equal(map.beatToMs(Rational.of(4)).toString(), "6200/3");
});

test("msToBeat inverts beatToMs exactly, including across segment boundaries", () => {
  const map = TempoMap.fromBpm(Rational.of(120));
  map.setTempo(Rational.of(2), Rational.of(60000).div(Rational.of(90)));
  map.setTempo(Rational.of(7, 2), Rational.of(60000).div(Rational.of(150)));

  const beats = ["0", "1/3", "2", "9/4", "7/2", "29/8", "10"].map(Rational.parse);
  for (const beat of beats) {
    const ms = map.beatToMs(beat);
    assert.ok(map.msToBeat(ms).equals(beat), `round trip failed for beat ${beat}`);
  }
  // and the other direction
  for (const beat of beats) {
    const ms = map.beatToMs(beat);
    assert.ok(map.beatToMs(map.msToBeat(ms)).equals(ms), `ms round trip failed for ${ms}`);
  }
});

test("tempo change keeps event beat positions, only derived ms move", () => {
  const score = new Score(TempoMap.fromBpm(Rational.of(120)));
  score.addEvent({ id: "a", track: 1, beat: Rational.of(3, 2), kind: "note" });
  score.addEvent({ id: "b", track: 1, beat: Rational.of(4), kind: "note" });

  const beatsBefore = score.getEvents().map((e) => e.beat.toString());
  const msBefore = score.timeline().map((t) => t.ms.toString());

  score.setTempo(Rational.of(1), Rational.of(60000).div(Rational.of(77)));

  const beatsAfter = score.getEvents().map((e) => e.beat.toString());
  const msAfter = score.timeline().map((t) => t.ms.toString());

  assert.deepEqual(beatsAfter, beatsBefore);
  assert.notEqual(msAfter[1], msBefore[1]);
  assert.equal(msAfter[1], score.tempoMap.beatToMs(Rational.of(4)).toString());
});

test("undo restores the old tempo exactly", () => {
  const score = new Score(TempoMap.fromBpm(Rational.of(120)));
  score.addEvent({ id: "a", track: 1, beat: Rational.of(5, 2), kind: "note" });
  const msOriginal = score.timeline().map((t) => t.ms.toString());
  const segmentsOriginal = score.tempoMap.getSegments().map((s) => s.msPerBeat.toString());

  score.setTempo(Rational.of(1), Rational.of(60000).div(Rational.of(90)));
  score.setTempo(Rational.of(2), Rational.of(60000).div(Rational.of(150)));
  assert.equal(score.tempoMap.getSegments().length, 3);

  assert.ok(score.undoTempo());
  assert.ok(score.undoTempo());
  assert.equal(score.undoTempo(), false); // nothing left to undo

  assert.deepEqual(
    score.tempoMap.getSegments().map((s) => s.msPerBeat.toString()),
    segmentsOriginal,
  );
  assert.deepEqual(score.timeline().map((t) => t.ms.toString()), msOriginal);
});

test("replacing tempo at an existing boundary does not create a new segment", () => {
  const map = TempoMap.fromBpm(Rational.of(120));
  map.setTempo(Rational.of(2), Rational.of(400));
  map.setTempo(Rational.of(2), Rational.of(250));
  assert.equal(map.getSegments().length, 2);
  assert.equal(map.beatToMs(Rational.of(3)).toString(), "1250");
});

test("rejects invalid input", () => {
  const map = new TempoMap();
  assert.throws(() => map.setTempo(Rational.of(-1), Rational.of(500)));
  assert.throws(() => map.setTempo(Rational.of(0), Rational.of(0)));
  assert.throws(() => map.beatToMs(Rational.of(-1)));
  assert.throws(() => map.msToBeat(Rational.of(-1)));
});
