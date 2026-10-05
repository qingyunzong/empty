import { test } from "node:test";
import assert from "node:assert/strict";
import { Rational } from "../src/rational";
import { TempoMap } from "../src/tempo-map";
import {
  generateCertificate,
  verifyCertificate,
  defaultSampleBeats,
} from "../src/certificate";

function buildMap(): TempoMap {
  const map = TempoMap.fromBpm(Rational.of(120));
  map.setTempo(Rational.of(2), Rational.of(60000).div(Rational.of(90)));
  map.setTempo(Rational.of(7, 2), Rational.of(60000).div(Rational.of(150)));
  return map;
}

test("generated certificate verifies against its tempo map", () => {
  const map = buildMap();
  const cert = generateCertificate(map);
  const result = verifyCertificate(map, cert);
  assert.deepEqual(result.failures, []);
  assert.ok(result.ok);
});

test("certificate covers both directions with exact round trips", () => {
  const map = buildMap();
  const cert = generateCertificate(map);
  assert.ok(cert.beatToMs.length > 0);
  assert.ok(cert.msToBeat.length > 0);
  for (const entry of cert.beatToMs) {
    assert.equal(entry.roundTripBeat, entry.beat);
  }
  for (const entry of cert.msToBeat) {
    assert.equal(entry.roundTripMs, entry.ms);
  }
});

test("tampered certificate fails verification", () => {
  const map = buildMap();
  const cert = generateCertificate(map);
  cert.beatToMs[0]!.ms = "999999";
  const result = verifyCertificate(map, cert);
  assert.equal(result.ok, false);
  assert.ok(result.failures.length > 0);
});

test("certificate from an older tempo does not verify after a tempo change", () => {
  const map = buildMap();
  const cert = generateCertificate(map);
  map.setTempo(Rational.of(5), Rational.of(60000).div(Rational.of(60)));
  const result = verifyCertificate(map, cert);
  assert.equal(result.ok, false);
  // undoing the change makes the old certificate valid again
  map.undo();
  assert.ok(verifyCertificate(map, cert).ok);
});

test("certificate is JSON-serializable and verifies after a round trip", () => {
  const map = buildMap();
  const cert = generateCertificate(map);
  const revived = JSON.parse(JSON.stringify(cert));
  assert.ok(verifyCertificate(map, revived).ok);
});

test("default sample beats hit every segment boundary", () => {
  const map = buildMap();
  const beats = defaultSampleBeats(map).map((b) => b.toString());
  for (const seg of map.getSegments()) {
    assert.ok(beats.includes(seg.startBeat.toString()));
  }
});
