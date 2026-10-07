import { test } from "node:test";
import { equal, ok } from "node:assert/strict";
import { Rational } from "../src/rational.js";
import { Timeline, keyframe } from "../src/timeline.js";

const r = (n: number | bigint, d: number | bigint = 1) => Rational.of(n, d);

test("duplicate timestamps: the last declared frame wins", () => {
  const tl = new Timeline([
    keyframe(0, r(0)),
    keyframe(2, r(1)),
    keyframe(2, r(5)),
    keyframe(4, r(3)),
  ]);
  equal(tl.frames.length, 3);
  ok(tl.sampleAt(2n).equals(r(5)));
  ok(tl.sampleAt(3n).equals(r(4)));
});

test("unsorted input is normalized", () => {
  const tl = new Timeline([keyframe(4, r(3)), keyframe(0, r(0)), keyframe(2, r(5))]);
  equal(tl.start, 0n);
  equal(tl.end, 4n);
  equal(tl.duration, 4n);
  ok(tl.sampleAt(1n).equals(r(5, 2)));
});

test("interpolation is exact rational, not float", () => {
  const tl = new Timeline([keyframe(0, r(0)), keyframe(3, r(1))]);
  ok(tl.sampleAt(1n).equals(r(1, 3)));
  ok(tl.sampleAt(2n).equals(r(2, 3)));
  const tl2 = new Timeline([keyframe(1, r(1, 3)), keyframe(4, r(2))]);
  ok(tl2.sampleAt(2n).equals(r(8, 9)));
});

test("before the first and after the last frame the endpoint values hold", () => {
  const tl = new Timeline([keyframe(2, r(7)), keyframe(5, r(-1))]);
  ok(tl.sampleAt(-100n).equals(r(7)));
  ok(tl.sampleAt(2n).equals(r(7)));
  ok(tl.sampleAt(5n).equals(r(-1)));
  ok(tl.sampleAt(1000n).equals(r(-1)));
});
