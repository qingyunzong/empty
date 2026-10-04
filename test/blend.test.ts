import { test } from "node:test";
import * as assert from "node:assert/strict";
import { blendOver, blendStack } from "../src/blend.js";
import { blendOverExact } from "../src/exact.js";
import { makePixel, TRANSPARENT, type Pixel } from "../src/pixel.js";
import { lcg, randInt } from "./helpers.js";

test("source-over formula: worked examples on denominator 255", () => {
  // src half alpha over opaque dst: a = 128 + rhe(255*127/255) = 255
  const out = blendOver(255, makePixel(255, 128, 0, 0, 128), makePixel(255, 0, 0, 255, 255));
  assert.deepEqual(out, [128, 0, 127, 255]);
  // transparent src is the identity
  const dst = makePixel(255, 10, 20, 30, 200);
  assert.deepEqual(blendOver(255, TRANSPARENT, dst), dst);
  // opaque src replaces dst entirely
  const src = makePixel(255, 1, 2, 3, 255);
  assert.deepEqual(blendOver(255, src, dst), src);
});

test("per-step rounding is half-even (ties exercised on even denominators)", () => {
  // den = 4, src alpha 2 -> inv = 2
  // dst alpha 1: 1*2/4 = 0.5  -> tie to even 0
  assert.deepEqual(blendOver(4, makePixel(4, 2, 2, 2, 2), makePixel(4, 1, 1, 1, 1)), [2, 2, 2, 2]);
  // dst alpha 3: 3*2/4 = 1.5  -> tie to even 2
  assert.deepEqual(blendOver(4, makePixel(4, 2, 2, 2, 2), makePixel(4, 3, 3, 3, 3)), [4, 4, 4, 4]);
  // den = 10, src alpha 5 -> inv = 5; dst 1 -> 0.5 -> 0, dst 3 -> 1.5 -> 2
  assert.deepEqual(blendOver(10, makePixel(10, 5, 5, 5, 5), makePixel(10, 1, 0, 0, 1)), [5, 5, 5, 5]);
  assert.deepEqual(blendOver(10, makePixel(10, 5, 5, 5, 5), makePixel(10, 3, 3, 3, 3)), [7, 7, 7, 7]);
});

test("rounding happens at every layer, not only at the end", () => {
  // den = 2, half-alpha layer: each step adds rhe(1*1/2) = 0 (tie to even),
  // so alpha stays 1 no matter how many identical layers are stacked.
  const p = makePixel(2, 1, 1, 1, 1);
  assert.deepEqual(blendStack(2, [p, p, p, p]), [1, 1, 1, 1]);
  // Rounding only once at the end would give 2*(1-(1/2)^4) = 1.875 -> 2.

  // den = 4, quarter-alpha layer: 1 -> 2 -> 3 -> 3 across four layers.
  const q = makePixel(4, 1, 1, 1, 1);
  assert.deepEqual(blendStack(4, [q, q, q, q]), [3, 3, 3, 3]);
});

test("fast pipeline matches exact BigInt arithmetic (randomised)", () => {
  for (const den of [2, 4, 10, 255, 256]) {
    const rand = lcg(den * 7919);
    for (let i = 0; i < 2000; i++) {
      const mk = (): Pixel => {
        const a = randInt(rand, 0, den);
        return makePixel(den, randInt(rand, 0, a), randInt(rand, 0, a), randInt(rand, 0, a), a);
      };
      const src = mk();
      const dst = mk();
      assert.deepEqual(
        blendOver(den, src, dst),
        blendOverExact(den, src, dst),
        `den=${den} src=${src} dst=${dst}`,
      );
    }
  }
});

test("blending never produces residual colour in transparent output", () => {
  const rand = lcg(424242);
  for (let i = 0; i < 5000; i++) {
    const den = 255;
    const mk = (): Pixel => {
      const a = randInt(rand, 0, den);
      return makePixel(den, randInt(rand, 0, a), randInt(rand, 0, a), randInt(rand, 0, a), a);
    };
    const out = blendOver(den, mk(), mk());
    if (out[3] === 0) {
      assert.deepEqual(out, [0, 0, 0, 0]);
    } else {
      assert.ok(out[0] <= out[3] && out[1] <= out[3] && out[2] <= out[3]);
    }
  }
});
