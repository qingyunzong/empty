import { test } from "node:test";
import assert from "node:assert/strict";
import { Fraction, Track } from "../src/index.js";
test("interpolates on integer time with exact rationals", () => {
    const track = new Track([
        { time: 0, value: 0 },
        { time: 3, value: 1 },
    ]);
    assert.ok(track.valueAt(0).equals(Fraction.of(0)));
    assert.ok(track.valueAt(1).equals(Fraction.of(1, 3)));
    assert.ok(track.valueAt(2).equals(Fraction.of(2, 3)));
    assert.ok(track.valueAt(3).equals(Fraction.of(1)));
});
test("interpolates fractional keyframe values exactly", () => {
    const track = new Track([
        { time: 0, value: Fraction.of(1, 2) },
        { time: 5, value: 2 },
    ]);
    // 1/2 + (2 - 1/2) * 2/5 = 1/2 + 3/5 = 11/10
    assert.ok(track.valueAt(2).equals(Fraction.of(11, 10)));
});
test("holds endpoint values outside the keyframe range", () => {
    const track = new Track([
        { time: 2, value: 7 },
        { time: 4, value: 9 },
    ]);
    assert.ok(track.valueAt(-100).equals(Fraction.of(7)));
    assert.ok(track.valueAt(1).equals(Fraction.of(7)));
    assert.ok(track.valueAt(4).equals(Fraction.of(9)));
    assert.ok(track.valueAt(1000).equals(Fraction.of(9)));
});
test("duplicate timestamps: the last keyframe wins", () => {
    const track = new Track([
        { time: 2, value: 1 },
        { time: 2, value: 3 },
        { time: 4, value: 5 },
    ]);
    assert.ok(track.valueAt(2).equals(Fraction.of(3)));
    // Segment after the duplicate starts from the winning frame.
    assert.ok(track.valueAt(3).equals(Fraction.of(4)));
});
test("duplicate timestamps at the boundaries", () => {
    const track = new Track([
        { time: 0, value: 1 },
        { time: 0, value: 2 },
        { time: 10, value: 8 },
        { time: 10, value: 9 },
    ]);
    assert.ok(track.valueAt(0).equals(Fraction.of(2)));
    assert.ok(track.valueAt(-5).equals(Fraction.of(1))); // before first: first keyframe holds
    assert.ok(track.valueAt(10).equals(Fraction.of(9)));
    assert.ok(track.valueAt(50).equals(Fraction.of(9))); // after last: last keyframe holds
});
test("unsorted input is ordered by time", () => {
    const track = new Track([
        { time: 4, value: 1 },
        { time: 0, value: 0 },
    ]);
    assert.ok(track.valueAt(2).equals(Fraction.of(1, 2)));
});
test("rejects non-integer time", () => {
    const track = new Track([{ time: 0, value: 0 }]);
    assert.throws(() => track.valueAt(1.5), TypeError);
    assert.throws(() => new Track([{ time: 0.5, value: 0 }]), TypeError);
});
