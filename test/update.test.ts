import { test } from "node:test";
import assert from "node:assert/strict";
import { Compositor, TILE_SIZE } from "../src/compositor.js";
import { Layer } from "../src/layer.js";

const D = 255;

function solidLayer(x: number, y: number, w: number, h: number, px: number[]): Layer {
  const data: number[] = [];
  for (let i = 0; i < w * h; i++) data.push(...px);
  return Layer.fromPixels(x, y, w, h, data, D);
}

test("rect update only rewrites affected output tiles", () => {
  // 40x40 canvas -> 3x3 = 9 tiles of 16px.
  const comp = new Compositor(40, 40, D);
  comp.addLayer(solidLayer(0, 0, 40, 40, [255, 0, 0, 255])); // opaque red
  comp.addLayer(solidLayer(8, 8, 16, 16, [0, 0, 128, 128])); // half-alpha blue
  const v0 = comp.composite();
  assert.equal(comp.totalTiles(), 9);

  // Update a 4x4 rect at layer-local (2,2) -> canvas (10,10)..(13,13),
  // entirely inside tile (0,0).
  const v1 = comp.updateRect(1, { x: 2, y: 2, width: 4, height: 4 },
    new Array(4 * 4 * 4).fill(0).map((_, i) => (i % 4 === 3 ? 255 : 0)));

  // 8 of 9 tiles must be shared by reference (provably untouched).
  assert.equal(comp.countSharedTiles(v0, v1), 8);

  // Every pixel outside the dirty rect is value-identical.
  for (let y = 0; y < 40; y++) {
    for (let x = 0; x < 40; x++) {
      const inRect = x >= 10 && x < 14 && y >= 10 && y < 14;
      const before = comp.getPixel(v0, x, y);
      const after = comp.getPixel(v1, x, y);
      if (!inRect) {
        assert.deepEqual(after, before, `pixel (${x},${y}) outside dirty rect changed`);
      } else {
        assert.deepEqual(after, { r: 0, g: 0, b: 0, a: 255 }, `pixel (${x},${y}) not updated`);
      }
    }
  }
});

test("old versions remain readable after updates", () => {
  const comp = new Compositor(20, 20, D);
  comp.addLayer(solidLayer(0, 0, 20, 20, [10, 20, 30, 255]));
  const v0 = comp.composite();
  const snapshot = comp.readVersion(v0);

  const v1 = comp.updateRect(0, { x: 0, y: 0, width: 5, height: 5 },
    new Array(5 * 5 * 4).fill(0).map((_, i) => (i % 4 === 3 ? 255 : 200)));
  const v2 = comp.updateRect(0, { x: 10, y: 10, width: 3, height: 3 },
    new Array(3 * 3 * 4).fill(0).map((_, i) => (i % 4 === 3 ? 255 : 100)));

  assert.equal(comp.versionCount(), 3);
  // v0 is byte-identical to the snapshot taken before both updates.
  assert.deepEqual(comp.readVersion(v0), snapshot);
  assert.deepEqual(comp.getPixel(v0, 2, 2), { r: 10, g: 20, b: 30, a: 255 });
  assert.deepEqual(comp.getPixel(v1, 2, 2), { r: 200, g: 200, b: 200, a: 255 });
  assert.deepEqual(comp.getPixel(v1, 11, 11), { r: 10, g: 20, b: 30, a: 255 });
  assert.deepEqual(comp.getPixel(v2, 11, 11), { r: 100, g: 100, b: 100, a: 255 });
  // The two updates touched disjoint tiles of the 20x20 canvas (2x2 tiles).
  assert.equal(comp.countSharedTiles(v0, v1), 3);
  assert.equal(comp.countSharedTiles(v1, v2), 3);
});

test("partial-tile update keeps the rest of the tile correct", () => {
  const comp = new Compositor(TILE_SIZE * 2, TILE_SIZE, D); // exactly 2 tiles
  comp.addLayer(solidLayer(0, 0, TILE_SIZE * 2, TILE_SIZE, [0, 0, 0, 255]));
  const v0 = comp.composite();
  // Dirty rect straddling the tile boundary at x = 16.
  const v1 = comp.updateRect(0, { x: 14, y: 4, width: 4, height: 4 },
    new Array(4 * 4 * 4).fill(0).map((_, i) => (i % 4 === 3 ? 255 : 255)));
  assert.equal(comp.countSharedTiles(v0, v1), 0); // both tiles intersected
  for (let y = 0; y < TILE_SIZE; y++) {
    for (let x = 0; x < TILE_SIZE * 2; x++) {
      const inRect = x >= 14 && x < 18 && y >= 4 && y < 8;
      const expected = inRect ? { r: 255, g: 255, b: 255, a: 255 } : { r: 0, g: 0, b: 0, a: 255 };
      assert.deepEqual(comp.getPixel(v1, x, y), expected, `pixel (${x},${y})`);
    }
  }
});

test("update fully outside canvas changes no output pixel", () => {
  const comp = new Compositor(10, 10, D);
  comp.addLayer(solidLayer(50, 50, 4, 4, [1, 2, 3, 255])); // off-canvas layer
  comp.addLayer(solidLayer(0, 0, 10, 10, [7, 7, 7, 255]));
  const v0 = comp.composite();
  const v1 = comp.updateRect(0, { x: 0, y: 0, width: 2, height: 2 }, [9, 9, 9, 255, 9, 9, 9, 255, 9, 9, 9, 255, 9, 9, 9, 255]);
  assert.equal(comp.countSharedTiles(v0, v1), 1);
  assert.deepEqual(comp.readVersion(v1), comp.readVersion(v0));
});
