import { test } from "node:test";
import assert from "node:assert/strict";
import { Rational } from "../src/rational";
import { Score } from "../src/score";
import { TempoMap } from "../src/tempo-map";

test("events at the same time order by track, then id", () => {
  const score = new Score(new TempoMap());
  score.addEvent({ id: "z9", track: 2, beat: Rational.of(1), kind: "note" });
  score.addEvent({ id: "b2", track: 1, beat: Rational.of(1), kind: "note" });
  score.addEvent({ id: "a1", track: 1, beat: Rational.of(1), kind: "note" });
  score.addEvent({ id: "x1", track: 3, beat: Rational.of(0), kind: "note" });
  score.addEvent({ id: "c3", track: 1, beat: Rational.of(1, 2), kind: "note" });

  const order = score.timeline().map((t) => t.event.id);
  assert.deepEqual(order, ["x1", "c3", "a1", "b2", "z9"]);
});

test("ordering is stable across tempo changes", () => {
  const score = new Score(TempoMap.fromBpm(Rational.of(120)));
  score.addEvent({ id: "n2", track: 2, beat: Rational.of(2), kind: "note" });
  score.addEvent({ id: "n1", track: 1, beat: Rational.of(2), kind: "note" });
  score.addEvent({ id: "n3", track: 1, beat: Rational.of(3), kind: "note" });

  const before = score.timeline().map((t) => t.event.id);
  score.setTempo(Rational.of(1), Rational.of(60000).div(Rational.of(200)));
  const after = score.timeline().map((t) => t.event.id);
  assert.deepEqual(after, before);
});
