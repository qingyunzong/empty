import { test } from "node:test";
import assert from "node:assert/strict";
import { Compositor } from "../src/compositor.js";
import { Layer } from "../src/layer.js";
import { Frac } from "../src/fraction.js";
import {
  computeExtrema,
  coverageMap,
  recomputeFractional,
  verifyAgainstInteger,
} from "../src/verify.js";
import { mulberry32, randInt, randomPremulPixel } from "./helpers.js";

const D = 255;

function randomLayers(rand: () => number, count: number, canvas: number): Layer[] {
  const layers: Layer[] = [];
  for (let i = 0; i < count; i++) {
    const w = randInt(rand, 1, canvas);
    const h = randInt(rand, 1, canvas);
    // Positions may be negative or hang off the canvas on purpose.
    const x = randInt(rand, -4, canvas - 1);
    const y = randInt(rand, -4, canvas - 1);
    const data: number[] = [];
    for (let p = 0; p < w * h; p++) data.push(...randomPremulPixel(rand, D));
    layers.push(Layer.fromPixels(x, y, w, h, data, D));
  }
  return layers;
}

test("independent fractional recompute matches integer pipeline (random stacks)", () => {
  for (const seed of [1, 42, 2026]) {
    const rand = mulberry32(seed);
    const size = 24;
    const layerCount = 6;
    const layers = randomLayers(rand, layerCount, size);
    const comp = new Compositor(size, size, D);
    for (const layer of layers) comp.addLayer(layer);
    const v = comp.composite();
    const intOutput = comp.readVersion(v);

    const report = verifyAgainstInteger(size, size, D, layers, intOutput);

    assert.equal(report.mismatches.length, 0,
      `seed ${seed}: ${report.mismatches.length} pixel mismatches, first: ${JSON.stringify(report.mismatches[0])}`);
    assert.equal(report.overlapMismatches, 0, `seed ${seed}: overlap mismatches`);
    assert.ok(report.overlapPixels > 0, `seed ${seed}: scenario must contain overlapping layers`);
    assert.equal(report.dirtyTransparentPixels, 0, `seed ${seed}: transparent pixels with residual color`);
    assert.equal(report.invariantViolations, 0, `seed ${seed}: premultiplied invariant violations`);

    // Accumulated rounding of the integer pipeline vs. the exact
    // unrounded composite must stay within layerCount half-ULPs.
    const bound = Frac.of(BigInt(layerCount), BigInt(2 * D));
    assert.ok(report.maxRoundingError.cmp(bound) <= 0,
      `seed ${seed}: rounding error ${report.maxRoundingError.n}/${report.maxRoundingError.d} exceeds ${layerCount}/(2*${D})`);
  }
});

test("extrema stay inside [0, denom] and color never exceeds alpha", () => {
  const rand = mulberry32(7);
  const size = 20;
  const layers = randomLayers(rand, 8, size);
  const comp = new Compositor(size, size, D);
  for (const layer of layers) comp.addLayer(layer);
  const out = comp.readVersion(comp.composite());
  const ext = computeExtrema(out);
  for (const ch of [ext.r, ext.g, ext.b, ext.a]) {
    assert.ok(ch.min >= 0 && ch.max <= D, `extrema ${JSON.stringify(ch)} outside [0, ${D}]`);
  }
  assert.ok(ext.r.max <= ext.a.max && ext.g.max <= ext.a.max && ext.b.max <= ext.a.max,
    "color maximum exceeds alpha maximum");
});

test("extrema of degenerate stacks hit the exact bounds", () => {
  // Fully transparent stack -> every channel exactly 0 everywhere.
  const compT = new Compositor(8, 8, D);
  compT.addLayer(Layer.transparent(0, 0, 8, 8, D));
  compT.addLayer(Layer.transparent(2, 2, 4, 4, D));
  const outT = compT.readVersion(compT.composite());
  assert.deepEqual(computeExtrema(outT), {
    r: { min: 0, max: 0 }, g: { min: 0, max: 0 },
    b: { min: 0, max: 0 }, a: { min: 0, max: 0 },
  });

  // Opaque white on top of anything -> every channel exactly denom.
  const compW = new Compositor(8, 8, D);
  compW.addLayer(Layer.fromPixels(0, 0, 8, 8, new Array(64 * 4).fill(0).map((_, i) => (i % 4 === 3 ? 255 : 30)), D));
  compW.addLayer(Layer.fromPixels(0, 0, 8, 8, new Array(64 * 4).fill(255), D));
  const outW = compW.readVersion(compW.composite());
  assert.deepEqual(computeExtrema(outW), {
    r: { min: 255, max: 255 }, g: { min: 255, max: 255 },
    b: { min: 255, max: 255 }, a: { min: 255, max: 255 },
  });
});

test("overlap regions: fractional recompute agrees where layers stack", () => {
  // Deterministic overlapping triple with fractional recompute cross-check.
  const comp = new Compositor(12, 12, D);
  const a = Layer.fromPixels(0, 0, 12, 12, new Array(144 * 4).fill(0).map((_, i) => (i % 4 === 3 ? 255 : 0)), D); // opaque black
  const bData: number[] = [];
  for (let i = 0; i < 6 * 6; i++) bData.push(100, 50, 25, 100);
  const b = Layer.fromPixels(3, 3, 6, 6, bData, D);
  const cData: number[] = [];
  for (let i = 0; i < 4 * 4; i++) cData.push(30, 60, 90, 120);
  const c = Layer.fromPixels(5, 5, 4, 4, cData, D);
  comp.addLayer(a);
  comp.addLayer(b);
  comp.addLayer(c);
  const out = comp.readVersion(comp.composite());

  const layers = [a, b, c];
  const coverage = coverageMap(12, 12, layers);
  // Overlap of all three layers: (5..8, 5..8) -> 16 pixels with coverage 3.
  let triple = 0;
  for (let i = 0; i < coverage.length; i++) if (coverage[i] === 3) triple++;
  assert.equal(triple, 16);

  const frac = recomputeFractional(12, 12, D, layers);
  for (let i = 0; i < coverage.length; i++) {
    if (coverage[i] >= 2) {
      for (let ch = 0; ch < 4; ch++) {
        assert.equal(out[i * 4 + ch], frac[i * 4 + ch],
          `overlap pixel ${i} channel ${ch}`);
      }
    }
  }
});

test("rect updates keep integer output in sync with fractional recompute", () => {
  const rand = mulberry32(99);
  const size = 20;
  const layers = randomLayers(rand, 5, size);
  const comp = new Compositor(size, size, D);
  for (const layer of layers) comp.addLayer(layer);
  comp.composite();

  // Apply several random rect updates to random layers.
  const current = [...layers];
  for (let step = 0; step < 8; step++) {
    const idx = randInt(rand, 0, current.length - 1);
    const layer = current[idx];
    const w = randInt(rand, 1, layer.width);
    const h = randInt(rand, 1, layer.height);
    const x = randInt(rand, 0, layer.width - w);
    const y = randInt(rand, 0, layer.height - h);
    const data: number[] = [];
    for (let p = 0; p < w * h; p++) data.push(...randomPremulPixel(rand, D));
    const v = comp.updateRect(idx, { x, y, width: w, height: h }, data);
    current[idx] = layer.withRect({ x, y, width: w, height: h }, data);

    const report = verifyAgainstInteger(size, size, D, current, comp.readVersion(v));
    assert.equal(report.mismatches.length, 0,
      `step ${step}: ${JSON.stringify(report.mismatches[0])}`);
    assert.equal(report.dirtyTransparentPixels, 0, `step ${step}: dirty transparent`);
    assert.equal(report.invariantViolations, 0, `step ${step}: invariant`);
  }
});
