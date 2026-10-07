import { test } from "node:test";
import { equal, ok, throws } from "node:assert/strict";
import { Animation } from "../src/animation.js";
import { Clock } from "../src/clock.js";
import { Rational } from "../src/rational.js";
import { Timeline, keyframe } from "../src/timeline.js";

const r = (n: number | bigint, d: number | bigint = 1) => Rational.of(n, d);

test("time advances only via tick while running", () => {
  const clock = new Clock();
  equal(clock.time, 0n);
  clock.tick(3);
  equal(clock.time, 3n);
  clock.pause();
  clock.tick(10);
  equal(clock.time, 3n);
  clock.resume();
  clock.tick(2n);
  equal(clock.time, 5n);
  throws(() => clock.tick(-1));
});

test("pause/resume never reads the wall clock", async () => {
  const clock = new Clock();
  clock.pause();
  await new Promise((resolve) => setTimeout(resolve, 20));
  clock.resume();
  equal(clock.time, 0n);
});

test("paused span contributes zero to the sampled animation", () => {
  const ramp = new Timeline([keyframe(0, r(0)), keyframe(4, r(2))]);
  const anim = new Animation(ramp, new Clock(), "repeat");
  const seen: Rational[] = [];
  const step = () => {
    anim.clock.tick(1);
    seen.push(anim.value);
  };
  step();
  step();
  anim.clock.pause();
  step();
  step();
  anim.clock.resume();
  step();
  step();
  step();
  const expected = [r(1, 2), r(1), r(1), r(1), r(3, 2), r(0), r(1, 2)];
  for (let i = 0; i < expected.length; i++) {
    ok(seen[i]!.equals(expected[i]!), `sample ${i}: got ${seen[i]}, want ${expected[i]}`);
  }
});

test("exact rational reference across repeated loop turns", () => {
  const tri = new Timeline([keyframe(0, r(0)), keyframe(3, r(1))]);
  const anim = new Animation(tri, new Clock(), "repeat");
  const reference: Rational[] = [];
  for (let cycle = 0; cycle < 3; cycle++) {
    reference.push(r(0), r(1, 3), r(2, 3));
  }
  for (const want of reference) {
    ok(anim.value.equals(want), `t=${anim.time}: got ${anim.value}, want ${want}`);
    anim.clock.tick(1);
  }
});
