import { test } from "node:test";
import assert from "node:assert/strict";
import { Animation, Fraction, Track, loopTime, reverseLoopTime } from "../src/index.js";
// Reference track: value(t) = t/4 on [0, 4], exact in rationals.
const track = new Track([
    { time: 0, value: 0 },
    { time: 4, value: 1 },
]);
const region = { start: 0, end: 4 };
test("forward loop maps the interval end back to the start", () => {
    assert.equal(loopTime(0, region), 0n);
    assert.equal(loopTime(3, region), 3n);
    assert.equal(loopTime(4, region), 0n); // end -> start
    assert.equal(loopTime(5, region), 1n);
    assert.equal(loopTime(9, region), 1n); // wraps across multiple periods
    assert.equal(loopTime(-1, region), 3n); // floor modulo for negative time
});
test("forward loop: exact rational reference across the wrap", () => {
    const anim = new Animation(track, { mode: "loop", region });
    const expected = [
        [2, "1/2"],
        [3, "3/4"],
        [4, "0"], // turn: end maps to start
        [5, "1/4"],
        [7, "3/4"],
        [8, "0"], // second wrap
        [9, "1/4"],
    ];
    for (const [t, ref] of expected) {
        assert.equal(anim.valueAt(t).toString(), ref, `t=${t}`);
    }
});
test("reverse loop is defined separately and mirrors at both ends", () => {
    assert.equal(reverseLoopTime(0, region), 0n);
    assert.equal(reverseLoopTime(4, region), 4n); // turning point touches end
    assert.equal(reverseLoopTime(5, region), 3n);
    assert.equal(reverseLoopTime(8, region), 0n); // back at start
    assert.equal(reverseLoopTime(9, region), 1n);
    assert.equal(reverseLoopTime(12, region), 4n); // second period turn
    assert.equal(reverseLoopTime(-1, region), 1n);
});
test("reverse loop: exact rational reference at the turning points", () => {
    const anim = new Animation(track, { mode: "reverse", region });
    const expected = [
        [3, "3/4"],
        [4, "1"], // upper turning point
        [5, "3/4"],
        [7, "1/4"],
        [8, "0"], // lower turning point
        [9, "1/4"],
        [11, "3/4"],
        [12, "1"], // upper turning point, second period
        [13, "3/4"],
        [16, "0"],
    ];
    for (const [t, ref] of expected) {
        assert.equal(anim.valueAt(t).toString(), ref, `t=${t}`);
    }
});
test("loop region offset from zero", () => {
    const shifted = new Track([
        { time: 10, value: 0 },
        { time: 13, value: 1 },
    ]);
    const anim = new Animation(shifted, { mode: "loop", region: { start: 10, end: 13 } });
    assert.ok(anim.valueAt(11).equals(Fraction.of(1, 3)));
    assert.ok(anim.valueAt(13).equals(Fraction.of(0))); // end -> start
    assert.ok(anim.valueAt(14).equals(Fraction.of(1, 3)));
});
test("non-looping animation samples the track directly", () => {
    const anim = new Animation(track);
    assert.ok(anim.valueAt(2).equals(Fraction.of(1, 2)));
    assert.ok(anim.valueAt(100).equals(Fraction.of(1))); // endpoint clamp
});
test("looping requires a valid region", () => {
    assert.throws(() => new Animation(track, { mode: "loop" }), TypeError);
    assert.throws(() => new Animation(track, { mode: "loop", region: { start: 4, end: 4 } }), RangeError);
});
