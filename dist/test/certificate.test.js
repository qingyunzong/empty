"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const node_test_1 = require("node:test");
const strict_1 = __importDefault(require("node:assert/strict"));
const fraction_1 = require("../src/fraction");
const tempoMap_1 = require("../src/tempoMap");
const certificate_1 = require("../src/certificate");
function buildMap() {
    const map = new tempoMap_1.TempoMap();
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
(0, node_test_1.test)("certificate round-trips are exact in both directions", () => {
    const cert = (0, certificate_1.buildCertificate)(buildMap());
    strict_1.default.equal(cert.kind, "tempo-map-bidirectional-certificate");
    strict_1.default.ok(cert.roundTrips.length > 0);
    for (const r of cert.roundTrips) {
        strict_1.default.ok(r.ok, `beat ${r.beat} -> ${r.ms} ms -> ${r.backBeat}`);
        strict_1.default.equal(r.beat, r.backBeat);
    }
    for (const r of cert.inverseRoundTrips) {
        strict_1.default.ok(r.ok, `ms ${r.ms} -> ${r.beat} beats -> ${r.backMs}`);
        strict_1.default.equal(r.ms, r.backMs);
    }
    strict_1.default.ok(cert.allPassed);
});
(0, node_test_1.test)("certificate agrees with the direct integration model", () => {
    const cert = (0, certificate_1.buildCertificate)(buildMap());
    strict_1.default.equal(cert.integration.length, 2);
    for (const check of cert.integration) {
        strict_1.default.ok(check.ok, `${check.direction} max error ${check.maxAbsError}`);
        strict_1.default.ok(check.maxAbsError <= check.tolerance);
    }
});
(0, node_test_1.test)("integration model matches exact map on a hand-computed case", () => {
    const map = new tempoMap_1.TempoMap();
    map.setTempo(0, 120); // 500 ms/beat
    map.setTempo(2, 240); // 250 ms/beat
    const exact = map.beatsToMs(3); // 1250 ms
    const numeric = (0, certificate_1.integrateBeatsToMs)(map, 3, 100000);
    strict_1.default.ok(Math.abs(numeric - exact.toNumber()) < 1e-6);
    const beatsNumeric = (0, certificate_1.integrateMsToBeats)(map, 1250, 100000);
    strict_1.default.ok(Math.abs(beatsNumeric - 3) < 1e-6);
});
(0, node_test_1.test)("tempo edit keeps beats, remaps ms, and undo restores old tempo certificate", () => {
    const map = buildMap();
    const beatsBefore = map.eventList.map((e) => e.beat.toString());
    const certBefore = (0, certificate_1.buildCertificate)(map);
    map.setTempo(4, 300); // change tempo; beats must not move
    strict_1.default.deepEqual(map.eventList.map((e) => e.beat.toString()), beatsBefore);
    const certEdited = (0, certificate_1.buildCertificate)(map);
    strict_1.default.notDeepEqual(certEdited.segments.map((s) => s.bpm), certBefore.segments.map((s) => s.bpm));
    map.undo();
    const certRestored = (0, certificate_1.buildCertificate)(map);
    strict_1.default.deepEqual(certRestored.segments, certBefore.segments);
    strict_1.default.ok(certRestored.allPassed);
});
(0, node_test_1.test)("event at exact segment boundary maps to the segment boundary ms", () => {
    const map = new tempoMap_1.TempoMap();
    map.setTempo(0, 120);
    map.setTempo(4, 60);
    strict_1.default.ok(map.beatsToMs(4).eq(fraction_1.Fraction.of(2000)));
    strict_1.default.ok(map.msToBeats(2000).eq(fraction_1.Fraction.of(4)));
});
