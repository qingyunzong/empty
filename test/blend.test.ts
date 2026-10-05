import { test } from "node:test";
import assert from "node:assert/strict";
import { blendPixel, canonicalize, assertValidPixel } from "../src/pixel.js";
import { Layer } from "../src/layer.js";

const D = 255;

test("opaque source fully covers destination", () => {
  const src = { r: 200, g: 100, b: 50, a: 255 };
  const dst = { r: 1, g: 2, b: 3, a: 255 };
  assert.deepEqual(blendPixel(src, dst, D), src);
});

test("transparent source leaves destination untouched", () => {
  const dst = { r: 10, g: 20, b: 30, a: 40 };
  assert.deepEqual(blendPixel({ r: 0, g: 0, b: 0, a: 0 }, dst, D), dst);
});

test("half-alpha white over opaque black (premultiplied source-over)", () => {
  // srcA = 128/255, inv = 127: outA = 128 + 255*127/255 = 255,
  // outC = 128 + 0 = 128.
  const out = blendPixel({ r: 128, g: 128, b: 128, a: 128 }, { r: 0, g: 0, b: 0, a: 255 }, D);
  assert.deepEqual(out, { r: 128, g: 128, b: 128, a: 255 });
});

test("per-step rounding is half-to-even, not half-up", () => {
  // Denominator 10: srcA = 5 -> inv = 5; dst.a = 5 -> 5*5/10 = 2.5.
  // Half-even gives 2 (half-up would give 3).
  const out = blendPixel({ r: 0, g: 0, b: 0, a: 5 }, { r: 0, g: 0, b: 0, a: 5 }, 10);
  assert.equal(out.a, 7);
  // 1.5 rounds to 2 (already even): srcA = 5, dst.a = 3 -> 15/10.
  const out2 = blendPixel({ r: 0, g: 0, b: 0, a: 5 }, { r: 0, g: 0, b: 0, a: 3 }, 10);
  assert.equal(out2.a, 7);
});

test("transparent output never retains residual color", () => {
  const out = blendPixel({ r: 0, g: 0, b: 0, a: 0 }, { r: 0, g: 0, b: 0, a: 0 }, D);
  assert.deepEqual(out, { r: 0, g: 0, b: 0, a: 0 });
  assert.deepEqual(canonicalize({ r: 9, g: 8, b: 7, a: 0 }), { r: 0, g: 0, b: 0, a: 0 });
});

test("blend preserves premultiplied invariant c <= a", () => {
  const out = blendPixel({ r: 100, g: 90, b: 80, a: 100 }, { r: 200, g: 150, b: 100, a: 200 }, D);
  assertValidPixel(out, D, "blend output");
});

test("layer canonicalizes transparent pixels with residual color", () => {
  const layer = Layer.fromPixels(0, 0, 2, 1, [5, 5, 5, 0, 10, 4, 2, 10], D);
  assert.deepEqual(layer.getPixel(0, 0), { r: 0, g: 0, b: 0, a: 0 });
  assert.deepEqual(layer.getPixel(1, 0), { r: 10, g: 4, b: 2, a: 10 });
});

test("layer rejects non-premultiplied or out-of-range pixels", () => {
  assert.throws(() => Layer.fromPixels(0, 0, 1, 1, [200, 0, 0, 100], D), RangeError);
  assert.throws(() => Layer.fromPixels(0, 0, 1, 1, [0, 0, 0, 300], D), RangeError);
  assert.throws(() => Layer.fromPixels(0, 0, 1, 1, [0, 0, 0], D), RangeError);
});

test("layer.withRect is immutable and validates input", () => {
  const layer = Layer.fromPixels(0, 0, 2, 2, [1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4], D);
  const updated = layer.withRect({ x: 1, y: 1, width: 1, height: 1 }, [9, 9, 9, 9]);
  assert.deepEqual(layer.getPixel(1, 1), { r: 4, g: 4, b: 4, a: 4 }); // old untouched
  assert.deepEqual(updated.getPixel(1, 1), { r: 9, g: 9, b: 9, a: 9 });
  assert.throws(() => layer.withRect({ x: 1, y: 1, width: 2, height: 1 }, [0, 0, 0, 0, 0, 0, 0, 0]), RangeError);
  assert.throws(() => layer.withRect({ x: 0, y: 0, width: 1, height: 1 }, [5, 0, 0, 1]), RangeError);
});
