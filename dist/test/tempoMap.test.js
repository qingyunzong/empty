"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const node_test_1 = require("node:test");
const strict_1 = __importDefault(require("node:assert/strict"));
const fraction_1 = require("../src/fraction");
const tempoMap_1 = require("../src/tempoMap");
(0, node_test_1.test)("constant tempo: 120bpm maps one beat to 500ms exactly", () => {
    const map = new tempoMap_1.TempoMap();
    strict_1.default.ok(map.beatsToMs(1).eq(fraction_1.Fraction.of(500)));
    strict_1.default.ok(map.beatsToMs("1/3").eq(fraction_1.Fraction.of(500, 3)));
    strict_1.default.ok(map.msToBeats(1250).eq(fraction_1.Fraction.of(5, 2)));
});
(0, node_test_1.test)("tempo change maps intervals to rational ms and keeps beat positions", () => {
    const map = new tempoMap_1.TempoMap();
    map.setTempo(0, 120); // 500 ms/beat
    map.setTempo(2, 240); // 250 ms/beat from beat 2
    // beat 3 = 2*500 + 1*250 = 1250 ms
    strict_1.default.ok(map.beatsToMs(3).eq(fraction_1.Fraction.of(1250)));
    // beat 7/2 = 1000 + 3/2*250 = 1375 ms
    strict_1.default.ok(map.beatsToMs("7/2").eq(fraction_1.Fraction.of(1375)));
    // inverse is exact too
    strict_1.default.ok(map.msToBeats(1375).eq(fraction_1.Fraction.of(7, 2)));
    // event beats are untouched by the tempo edit
    map.addEvent("a", 0, "7/2");
    strict_1.default.ok(map.eventList[0].beat.eq(fraction_1.Fraction.of(7, 2)));
});
(0, node_test_1.test)("non-integer bpm still yields rational ms", () => {
    const map = new tempoMap_1.TempoMap();
    map.setTempo(0, "179.5"); // 60000/179.5 = 120000/359 ms per beat
    strict_1.default.ok(map.beatsToMs(1).eq(fraction_1.Fraction.of(120000, 359)));
    strict_1.default.ok(map.msToBeats(fraction_1.Fraction.of(120000, 359)).eq(fraction_1.Fraction.of(1)));
});
(0, node_test_1.test)("same-time events order by track then id", () => {
    const map = new tempoMap_1.TempoMap();
    map.addEvent("zeta", 2, 1);
    map.addEvent("beta", 0, 1);
    map.addEvent("alpha", 0, 1);
    map.addEvent("gamma", 1, 1);
    map.addEvent("first", 5, 0);
    const ids = map.timeline().map((e) => e.id);
    strict_1.default.deepEqual(ids, ["first", "alpha", "beta", "gamma", "zeta"]);
});
(0, node_test_1.test)("undo restores the previous tempo and its mapping", () => {
    const map = new tempoMap_1.TempoMap();
    map.setTempo(0, 120);
    map.setTempo(4, 60);
    const before = map.beatsToMs(8);
    map.setTempo(4, 240); // overwrite tempo at beat 4
    strict_1.default.notEqual(map.beatsToMs(8).toString(), before.toString());
    strict_1.default.equal(map.undo(), true);
    strict_1.default.ok(map.beatsToMs(8).eq(before));
    strict_1.default.equal(map.bpmAt(4).toString(), "60");
    map.undo();
    strict_1.default.equal(map.tempoPoints.length, 1); // back to default
    strict_1.default.equal(map.undo(), true); // initial setTempo(0, 120) undone
    strict_1.default.equal(map.undo(), false); // stack exhausted
});
(0, node_test_1.test)("undo of an inserted point removes it", () => {
    const map = new tempoMap_1.TempoMap();
    map.setTempo(0, 100);
    map.setTempo(8, 200);
    strict_1.default.equal(map.tempoPoints.length, 2);
    map.undo();
    strict_1.default.equal(map.tempoPoints.length, 1);
    strict_1.default.ok(map.beatsToMs(8).eq(fraction_1.Fraction.of(4800))); // 8 * 600ms
});
(0, node_test_1.test)("rejects invalid input", () => {
    const map = new tempoMap_1.TempoMap();
    strict_1.default.throws(() => map.setTempo(0, 0));
    strict_1.default.throws(() => map.setTempo(-1, 120));
    strict_1.default.throws(() => map.beatsToMs(-1));
    strict_1.default.throws(() => map.msToBeats(-1));
});
