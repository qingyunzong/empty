import { test } from "node:test";
import * as assert from "node:assert/strict";
import { LayerDocument } from "../src/document.js";
import { Compositor } from "../src/compositor.js";
import { compositeExact, extrema } from "../src/exact.js";
import { buffersEqual, lcg, randInt } from "./helpers.js";

test("independent fraction recompute: extrema, premultiplied bounds, transparency", () => {
  const W = 16;
  const H = 16;
  for (const den of [2, 4, 10, 255, 256]) {
    const rand = lcg(den * 31337);
    const doc = new LayerDocument(W, H, den);
    const layerCount = 4;
    for (let l = 0; l < layerCount; l++) {
      doc.addLayer();
    }
    // Fill layers with random rects, including extreme alphas (0 and den)
    // and "dirty" transparent paints whose colour must be dropped.
    for (let i = 0; i < 40; i++) {
      const rect = {
        x: randInt(rand, 0, W - 1),
        y: randInt(rand, 0, H - 1),
        w: randInt(rand, 1, 6),
        h: randInt(rand, 1, 6),
      };
      const layer = randInt(rand, 0, layerCount - 1);
      doc.updateRect(layer, rect, () => {
        const roll = rand();
        if (roll < 0.15) return [den, den, den, 0]; // transparent with residual colour
        if (roll < 0.3) return [den, den, den, den]; // fully opaque extreme
        const a = randInt(rand, 0, den);
        return [randInt(rand, 0, a), randInt(rand, 0, a), randInt(rand, 0, a), a];
      });
    }

    const compositor = new Compositor(W, H, den);
    const fast = compositor.fullRecompute(doc);
    const exact = compositeExact(doc.snapshot().layers, W, H, den);
    assert.ok(buffersEqual(fast, exact), `fast pipeline diverged from exact (den=${den})`);

    const { min, max } = extrema(fast);
    for (let c = 0; c < 4; c++) {
      assert.ok(min[c] >= 0, `den=${den} channel ${c} min ${min[c]}`);
      assert.ok(max[c] <= den, `den=${den} channel ${c} max ${max[c]}`);
    }
    for (let i = 0; i < fast.length; i += 4) {
      const a = fast[i + 3];
      if (a === 0) {
        assert.equal(fast[i], 0, `residual red at pixel ${i / 4}`);
        assert.equal(fast[i + 1], 0, `residual green at pixel ${i / 4}`);
        assert.equal(fast[i + 2], 0, `residual blue at pixel ${i / 4}`);
      } else {
        assert.ok(fast[i] <= a && fast[i + 1] <= a && fast[i + 2] <= a, `premultiplied bound at pixel ${i / 4}`);
      }
    }
  }
});

test("extrema of a single opaque layer reach the denominator", () => {
  const doc = new LayerDocument(4, 4, 255);
  doc.addLayer([255, 255, 255, 255]);
  const compositor = new Compositor(4, 4, 255);
  const { min, max } = extrema(compositor.fullRecompute(doc));
  assert.deepEqual(min, [255, 255, 255, 255]);
  assert.deepEqual(max, [255, 255, 255, 255]);
});
