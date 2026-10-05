import { test } from "node:test";
import assert from "node:assert/strict";
import { Track, keyframe } from "../src/timeline.js";
import { easeInQuad, step } from "../src/easing.js";
import { rat } from "../src/rational.js";

test("exact values at rational keyframe times", () => {
  const track = new Track([
    keyframe(0, 1, 10),
    keyframe(1, 3, 20),
    keyframe(5, 7, -4),
  ]);
  assert.equal(track.evaluate(rat(0)), 10);
  assert.equal(track.evaluate(rat(1, 3)), 20);
  assert.equal(track.evaluate(rat(5, 7)), -4);
});

test("clamping outside the key range", () => {
  const track = new Track([keyframe(1, 2, 3), keyframe(2, 1, 9)]);
  assert.equal(track.evaluate(rat(-100)), 3);
  assert.equal(track.evaluate(rat(1, 2)), 3);
  assert.equal(track.evaluate(rat(2)), 9);
  assert.equal(track.evaluate(rat(10 ** 9)), 9);
});

test("linear interpolation at exact rational midpoints", () => {
  const track = new Track([keyframe(0, 1, 0), keyframe(1, 3, 1)]);
  assert.equal(track.evaluate(rat(1, 6)), 0.5); // u = 1/2
  assert.equal(track.evaluate(rat(1, 9)), 1 / 3); // u = 1/3
});

test("easing applies to the segment started by its keyframe", () => {
  const track = new Track([
    keyframe(0, 1, 0, easeInQuad),
    keyframe(1, 1, 1),
  ]);
  assert.equal(track.evaluate(rat(1, 2)), 0.25); // (1/2)^2
});

test("keyframe time owned by the segment to its right (step easing)", () => {
  const track = new Track([
    keyframe(0, 1, 5, step),
    keyframe(1, 1, 7),
  ]);
  assert.equal(track.evaluate(rat(1, 2)), 5); // held
  assert.equal(track.evaluate(rat(1)), 7); // key's own value, not the held one
});

test("keyframes may be given out of order; duplicates rejected", () => {
  const track = new Track([keyframe(1, 1, 2), keyframe(0, 1, 1)]);
  assert.equal(track.evaluate(rat(1, 2)), 1.5);
  assert.throws(() => new Track([keyframe(1, 2, 0), keyframe(2, 4, 1)]));
});
