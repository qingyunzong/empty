import { test } from "node:test";
import assert from "node:assert/strict";
import { Animation, Clock, Fraction, Track } from "../src/index.js";
test("time advances only through tick", () => {
    const clock = new Clock();
    assert.equal(clock.time, 0n);
    clock.tick(3);
    clock.tick(2);
    assert.equal(clock.time, 5n);
});
test("pause and resume never read the wall clock", () => {
    const clock = new Clock();
    clock.tick(3);
    clock.pause();
    clock.tick(10); // ignored while paused
    assert.equal(clock.time, 3n);
    clock.resume();
    clock.tick(2); // resumes exactly at 3, no catch-up for paused time
    assert.equal(clock.time, 5n);
});
test("paused sequence is deterministic across runs", () => {
    const run = () => {
        const clock = new Clock();
        const anim = new Animation(new Track([
            { time: 0, value: 0 },
            { time: 4, value: 1 },
        ]), { mode: "loop", region: { start: 0, end: 4 } });
        const samples = [];
        for (let i = 0; i < 10; i++) {
            if (i === 4)
                clock.pause();
            if (i === 7)
                clock.resume();
            clock.tick(1);
            samples.push(anim.valueAt(clock.time).toString());
        }
        return samples;
    };
    const first = run();
    const second = run();
    assert.deepEqual(first, second);
    // Paused ticks do not advance: positions 1,2,3,4,4,4,4,5,6,7 -> wrapped.
    assert.deepEqual(first, ["1/4", "1/2", "3/4", "0", "0", "0", "0", "1/4", "1/2", "3/4"]);
});
test("clock drives an animation to exact rational values", () => {
    const clock = new Clock();
    const anim = new Animation(new Track([
        { time: 0, value: 0 },
        { time: 6, value: 1 },
    ]), { mode: "reverse", region: { start: 0, end: 6 } });
    clock.tick(8); // past the turning point at t=6
    assert.ok(anim.valueAt(clock.time).equals(Fraction.of(2, 3)));
    clock.seek(6);
    assert.ok(anim.valueAt(clock.time).equals(Fraction.ONE));
});
