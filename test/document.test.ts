import { test } from "node:test";
import * as assert from "node:assert/strict";
import { LayerDocument } from "../src/document.js";
import { Compositor } from "../src/compositor.js";
import { compositeExact } from "../src/exact.js";
import { buffersEqual, lcg, randInt } from "./helpers.js";

const W = 8;
const H = 8;
const DEN = 255;

function makeDoc(): { doc: LayerDocument; compositor: Compositor } {
  const doc = new LayerDocument(W, H, DEN);
  doc.addLayer([200, 100, 50, 255]); // opaque base
  doc.addLayer([10, 20, 30, 128]);   // translucent overlay
  return { doc, compositor: new Compositor(W, H, DEN) };
}

test("rect update recomputes only the affected output region", () => {
  const { doc, compositor } = makeDoc();
  const before = compositor.render(doc);
  assert.equal(before.region?.w, W);
  assert.equal(before.region?.h, H);

  const rect = { x: 2, y: 3, w: 3, h: 2 };
  doc.updateRect(0, rect, [255, 0, 0, 255]);
  const after = compositor.render(doc);

  assert.deepEqual(after.region, rect);
  assert.equal(compositor.pixelsRecomputed, rect.w * rect.h);

  // Outside the rect the output is byte-identical; inside it matches a
  // from-scratch recompute.
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = (y * W + x) * 4;
      const inside = x >= rect.x && x < rect.x + rect.w && y >= rect.y && y < rect.y + rect.h;
      for (let c = 0; c < 4; c++) {
        if (!inside) {
          assert.equal(after.output[i + c], before.output[i + c], `untouched (${x},${y})`);
        }
      }
    }
  }
  assert.ok(buffersEqual(after.output, compositor.fullRecompute(doc)));
});

test("old versions stay readable after updates", () => {
  const { doc, compositor } = makeDoc();
  const v0 = doc.currentVersion;
  const out0 = compositor.fullRecompute(doc, v0);

  doc.updateRect(0, { x: 0, y: 0, w: 4, h: 4 }, [0, 0, 255, 255]);
  doc.updateRect(1, { x: 2, y: 2, w: 4, h: 4 }, [255, 255, 0, 64]);
  assert.equal(doc.currentVersion, v0 + 2);

  // The old snapshot's layer data is untouched...
  assert.deepEqual(doc.snapshot(v0).layers[0].getPixel(0, 0), [200, 100, 50, 255]);
  // ...and re-rendering the old version reproduces the original output.
  assert.ok(buffersEqual(compositor.fullRecompute(doc, v0), out0));
  // Snapshotting a version that does not exist is an error.
  assert.throws(() => doc.snapshot(v0 + 3));
});

test("overlapping rect updates: incremental render equals full recompute", () => {
  const { doc, compositor } = makeDoc();
  compositor.render(doc);
  const rand = lcg(20261005);
  // A chain of overlapping, partially-out-of-bounds rects on both layers.
  for (let i = 0; i < 24; i++) {
    const rect = {
      x: randInt(rand, -2, W - 1),
      y: randInt(rand, -2, H - 1),
      w: randInt(rand, 1, 5),
      h: randInt(rand, 1, 5),
    };
    const layer = randInt(rand, 0, 1);
    const a = randInt(rand, 0, DEN);
    doc.updateRect(layer, rect, () => [randInt(rand, 0, a), randInt(rand, 0, a), randInt(rand, 0, a), a]);
    const inc = compositor.render(doc);
    assert.ok(
      buffersEqual(inc.output, compositor.fullRecompute(doc)),
      `diverged after update ${i} (rect=${JSON.stringify(rect)})`,
    );
  }
});

test("structural changes force a full recompute", () => {
  const { doc, compositor } = makeDoc();
  compositor.render(doc);
  doc.addLayer([0, 0, 0, 90]);
  const res = compositor.render(doc);
  assert.deepEqual(res.region, { x: 0, y: 0, w: W, h: H });
  assert.ok(buffersEqual(res.output, compositor.fullRecompute(doc)));
});

test("re-rendering the same version recomputes nothing", () => {
  const { doc, compositor } = makeDoc();
  compositor.render(doc);
  const again = compositor.render(doc);
  assert.equal(again.region, null);
  assert.equal(compositor.pixelsRecomputed, 0);
});

test("incremental render matches exact BigInt composite after rect updates", () => {
  const { doc, compositor } = makeDoc();
  compositor.render(doc);
  doc.updateRect(0, { x: 1, y: 1, w: 6, h: 6 }, [128, 64, 32, 200]);
  doc.updateRect(1, { x: 3, y: 0, w: 5, h: 8 }, [255, 255, 255, 77]);
  const inc = compositor.render(doc);
  const exact = compositeExact(doc.snapshot().layers, W, H, DEN);
  assert.ok(buffersEqual(inc.output, exact));
});
