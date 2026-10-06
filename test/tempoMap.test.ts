import { test } from "node:test";
import assert from "node:assert/strict";
import { Fraction } from "../src/fraction";
import { TempoMap } from "../src/tempoMap";

test("constant tempo: 120bpm maps one beat to 500ms exactly", () => {
  const map = new TempoMap();
  assert.ok(map.beatsToMs(1).eq(Fraction.of(500)));
  assert.ok(map.beatsToMs("1/3").eq(Fraction.of(500, 3)));
  assert.ok(map.msToBeats(1250).eq(Fraction.of(5, 2)));
});

test("tempo change maps intervals to rational ms and keeps beat positions", () => {
  const map = new TempoMap();
  map.setTempo(0, 120); // 500 ms/beat
  map.setTempo(2, 240); // 250 ms/beat from beat 2
  // beat 3 = 2*500 + 1*250 = 1250 ms
  assert.ok(map.beatsToMs(3).eq(Fraction.of(1250)));
  // beat 7/2 = 1000 + 3/2*250 = 1375 ms
  assert.ok(map.beatsToMs("7/2").eq(Fraction.of(1375)));
  // inverse is exact too
  assert.ok(map.msToBeats(1375).eq(Fraction.of(7, 2)));
  // event beats are untouched by the tempo edit
  map.addEvent("a", 0, "7/2");
  assert.ok(map.eventList[0]!.beat.eq(Fraction.of(7, 2)));
});

test("non-integer bpm still yields rational ms", () => {
  const map = new TempoMap();
  map.setTempo(0, "179.5"); // 60000/179.5 = 120000/359 ms per beat
  assert.ok(map.beatsToMs(1).eq(Fraction.of(120000, 359)));
  assert.ok(map.msToBeats(Fraction.of(120000, 359)).eq(Fraction.of(1)));
});

test("same-time events order by track then id", () => {
  const map = new TempoMap();
  map.addEvent("zeta", 2, 1);
  map.addEvent("beta", 0, 1);
  map.addEvent("alpha", 0, 1);
  map.addEvent("gamma", 1, 1);
  map.addEvent("first", 5, 0);
  const ids = map.timeline().map((e) => e.id);
  assert.deepEqual(ids, ["first", "alpha", "beta", "gamma", "zeta"]);
});

test("undo restores the previous tempo and its mapping", () => {
  const map = new TempoMap();
  map.setTempo(0, 120);
  map.setTempo(4, 60);
  const before = map.beatsToMs(8);
  map.setTempo(4, 240); // overwrite tempo at beat 4
  assert.notEqual(map.beatsToMs(8).toString(), before.toString());
  assert.equal(map.undo(), true);
  assert.ok(map.beatsToMs(8).eq(before));
  assert.equal(map.bpmAt(4).toString(), "60");
  map.undo();
  assert.equal(map.tempoPoints.length, 1); // back to default
  assert.equal(map.undo(), true); // initial setTempo(0, 120) undone
  assert.equal(map.undo(), false); // stack exhausted
});

test("undo of an inserted point removes it", () => {
  const map = new TempoMap();
  map.setTempo(0, 100);
  map.setTempo(8, 200);
  assert.equal(map.tempoPoints.length, 2);
  map.undo();
  assert.equal(map.tempoPoints.length, 1);
  assert.ok(map.beatsToMs(8).eq(Fraction.of(4800))); // 8 * 600ms
});

test("rejects invalid input", () => {
  const map = new TempoMap();
  assert.throws(() => map.setTempo(0, 0));
  assert.throws(() => map.setTempo(-1, 120));
  assert.throws(() => map.beatsToMs(-1));
  assert.throws(() => map.msToBeats(-1));
});
