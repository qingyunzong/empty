import { test } from "node:test";
import assert from "node:assert/strict";
import { Fraction } from "../src/fraction";
import { TempoMap } from "../src/tempoMap";
import { buildCertificate, integrateBeatsToMs, integrateMsToBeats } from "../src/certificate";

function buildMap(): TempoMap {
  const map = new TempoMap();
  map.setTempo(0, 120);
  map.setTempo(4, "179.5");
  map.setTempo("15/2", 90);
  map.addEvent("kick", 1, 0);
  map.addEvent("snare", 2, 2);
  map.addEvent("lead", 0, 2);
  map.addEvent("fill", 1, "15/2");
  map.addEvent("out", 0, 12);
  return map;
}

test("certificate round-trips are exact in both directions", () => {
  const cert = buildCertificate(buildMap());
  assert.equal(cert.kind, "tempo-map-bidirectional-certificate");
  assert.ok(cert.roundTrips.length > 0);
  for (const r of cert.roundTrips) {
    assert.ok(r.ok, `beat ${r.beat} -> ${r.ms} ms -> ${r.backBeat}`);
    assert.equal(r.beat, r.backBeat);
  }
  for (const r of cert.inverseRoundTrips) {
    assert.ok(r.ok, `ms ${r.ms} -> ${r.beat} beats -> ${r.backMs}`);
    assert.equal(r.ms, r.backMs);
  }
  assert.ok(cert.allPassed);
});

test("certificate agrees with the direct integration model", () => {
  const cert = buildCertificate(buildMap());
  assert.equal(cert.integration.length, 2);
  for (const check of cert.integration) {
    assert.ok(check.ok, `${check.direction} max error ${check.maxAbsError}`);
    assert.ok(check.maxAbsError <= check.tolerance);
  }
});

test("integration model matches exact map on a hand-computed case", () => {
  const map = new TempoMap();
  map.setTempo(0, 120); // 500 ms/beat
  map.setTempo(2, 240); // 250 ms/beat
  const exact = map.beatsToMs(3); // 1250 ms
  const numeric = integrateBeatsToMs(map, 3, 100000);
  assert.ok(Math.abs(numeric - exact.toNumber()) < 1e-6);
  const beatsNumeric = integrateMsToBeats(map, 1250, 100000);
  assert.ok(Math.abs(beatsNumeric - 3) < 1e-6);
});

test("tempo edit keeps beats, remaps ms, and undo restores old tempo certificate", () => {
  const map = buildMap();
  const beatsBefore = map.eventList.map((e) => e.beat.toString());
  const certBefore = buildCertificate(map);
  map.setTempo(4, 300); // change tempo; beats must not move
  assert.deepEqual(
    map.eventList.map((e) => e.beat.toString()),
    beatsBefore,
  );
  const certEdited = buildCertificate(map);
  assert.notDeepEqual(
    certEdited.segments.map((s) => s.bpm),
    certBefore.segments.map((s) => s.bpm),
  );
  map.undo();
  const certRestored = buildCertificate(map);
  assert.deepEqual(certRestored.segments, certBefore.segments);
  assert.ok(certRestored.allPassed);
});

test("event at exact segment boundary maps to the segment boundary ms", () => {
  const map = new TempoMap();
  map.setTempo(0, 120);
  map.setTempo(4, 60);
  assert.ok(map.beatsToMs(4).eq(Fraction.of(2000)));
  assert.ok(map.msToBeats(2000).eq(Fraction.of(4)));
});
