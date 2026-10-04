import { test } from "node:test";
import * as assert from "node:assert/strict";
import { makePixel, isTransparent, TRANSPARENT } from "../src/pixel.js";

test("transparent pixels keep no residual colour", () => {
  assert.deepEqual(makePixel(255, 10, 20, 30, 0), [0, 0, 0, 0]);
  assert.deepEqual(makePixel(255, 255, 255, 255, 0), [0, 0, 0, 0]);
  assert.ok(isTransparent(makePixel(255, 99, 99, 99, 0)));
});

test("channels clamp into the premultiplied range [0, alpha]", () => {
  assert.deepEqual(makePixel(255, 300, -5, 40, 100), [100, 0, 40, 100]);
  assert.deepEqual(makePixel(255, 0, 0, 0, 999), [0, 0, 0, 255]);
  assert.deepEqual(makePixel(4, 4, 4, 4, 4), [4, 4, 4, 4]);
});

test("non-integer numerators and bad denominators are rejected", () => {
  assert.throws(() => makePixel(255, 0.5, 0, 0, 1));
  assert.throws(() => makePixel(0, 0, 0, 0, 0));
  assert.throws(() => makePixel(-3, 0, 0, 0, 0));
});

test("TRANSPARENT constant is the zero pixel", () => {
  assert.deepEqual(TRANSPARENT, [0, 0, 0, 0]);
});
