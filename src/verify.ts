/**
 * Independent verification: recomputes the full layer stack with exact
 * rational (BigInt fraction) arithmetic — a separate code path from the
 * integer pipeline — and cross-checks per-pixel equality, channel extrema
 * and overlapping regions.
 */

import { Frac, roundToGridHalfEven } from "./fraction.js";
import { Layer } from "./layer.js";

export interface FracPixel {
  r: Frac;
  g: Frac;
  b: Frac;
  a: Frac;
}

const ZERO = Frac.zero();

function transparentFrac(): FracPixel {
  return { r: ZERO, g: ZERO, b: ZERO, a: ZERO };
}

/**
 * Fold the whole stack at canvas pixel (x, y) using exact fractions.
 * When `roundPerLayer` is true, each blend step rounds back to the
 * 1/denom grid with ties-to-even (mirroring the spec); otherwise the
 * result is the exact unrounded composite, used for error bounds.
 */
export function compositePixelExact(
  layers: readonly Layer[],
  denom: number,
  x: number,
  y: number,
  roundPerLayer: boolean,
): FracPixel {
  let acc = transparentFrac();
  const grid = BigInt(denom);
  for (const layer of layers) {
    const lx = x - layer.x;
    const ly = y - layer.y;
    if (lx < 0 || ly < 0 || lx >= layer.width || ly >= layer.height) continue;
    const px = layer.getPixel(lx, ly);
    const src: FracPixel = {
      r: Frac.of(px.r).mul(Frac.of(1n, BigInt(denom))),
      g: Frac.of(px.g).mul(Frac.of(1n, BigInt(denom))),
      b: Frac.of(px.b).mul(Frac.of(1n, BigInt(denom))),
      a: Frac.of(px.a).mul(Frac.of(1n, BigInt(denom))),
    };
    const inv = Frac.of(1n).sub(src.a);
    let next: FracPixel = {
      r: src.r.add(acc.r.mul(inv)),
      g: src.g.add(acc.g.mul(inv)),
      b: src.b.add(acc.b.mul(inv)),
      a: src.a.add(acc.a.mul(inv)),
    };
    if (roundPerLayer) {
      next = {
        r: Frac.of(roundToGridHalfEven(next.r, grid)).mul(Frac.of(1n, BigInt(denom))),
        g: Frac.of(roundToGridHalfEven(next.g, grid)).mul(Frac.of(1n, BigInt(denom))),
        b: Frac.of(roundToGridHalfEven(next.b, grid)).mul(Frac.of(1n, BigInt(denom))),
        a: Frac.of(roundToGridHalfEven(next.a, grid)).mul(Frac.of(1n, BigInt(denom))),
      };
      if (next.a.cmp(ZERO) === 0) next = transparentFrac();
    }
    acc = next;
  }
  return acc;
}

/** Full-canvas fractional recompute, rounded per layer to numerator grid. */
export function recomputeFractional(
  width: number,
  height: number,
  denom: number,
  layers: readonly Layer[],
): Uint32Array {
  const out = new Uint32Array(width * height * 4);
  const grid = BigInt(denom);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const px = compositePixelExact(layers, denom, x, y, true);
      const o = (y * width + x) * 4;
      out[o] = Number(roundToGridHalfEven(px.r, grid));
      out[o + 1] = Number(roundToGridHalfEven(px.g, grid));
      out[o + 2] = Number(roundToGridHalfEven(px.b, grid));
      out[o + 3] = Number(roundToGridHalfEven(px.a, grid));
    }
  }
  return out;
}

export interface ChannelExtrema {
  min: number;
  max: number;
}

export interface Extrema {
  r: ChannelExtrema;
  g: ChannelExtrema;
  b: ChannelExtrema;
  a: ChannelExtrema;
}

/** Min/max of every channel across a composited RGBA numerator buffer. */
export function computeExtrema(buf: Uint32Array): Extrema {
  const init = (): ChannelExtrema => ({ min: Infinity, max: -Infinity });
  const ext: Extrema = { r: init(), g: init(), b: init(), a: init() };
  const keys: (keyof Extrema)[] = ["r", "g", "b", "a"];
  for (let i = 0; i < buf.length; i += 4) {
    for (let c = 0; c < 4; c++) {
      const v = buf[i + c];
      const e = ext[keys[c]];
      if (v < e.min) e.min = v;
      if (v > e.max) e.max = v;
    }
  }
  return ext;
}

/** Number of layers covering each canvas pixel (row-major, w*h entries). */
export function coverageMap(
  width: number,
  height: number,
  layers: readonly Layer[],
): Uint32Array {
  const cov = new Uint32Array(width * height);
  for (const layer of layers) {
    const x0 = Math.max(0, layer.x);
    const y0 = Math.max(0, layer.y);
    const x1 = Math.min(width, layer.x + layer.width);
    const y1 = Math.min(height, layer.y + layer.height);
    for (let y = y0; y < y1; y++) {
      for (let x = x0; x < x1; x++) {
        cov[y * width + x]++;
      }
    }
  }
  return cov;
}

export interface VerifyReport {
  /** Pixels where integer pipeline != fractional recompute. */
  mismatches: Array<{ x: number; y: number; int: number[]; frac: number[] }>;
  extrema: Extrema;
  /** Count of pixels covered by two or more layers. */
  overlapPixels: number;
  /** Mismatches restricted to overlapping pixels (subset of mismatches). */
  overlapMismatches: number;
  /** Pixels where a transparent output retained residual color. */
  dirtyTransparentPixels: number;
  /** Pixels violating the premultiplied invariant c <= a. */
  invariantViolations: number;
  /**
   * Largest |intPipeline - exactUnrounded| over all pixels/channels, in
   * numerator units (fractions allowed, as exact rationals compared).
   */
  maxRoundingError: Frac;
}

/** Cross-check the integer pipeline output against exact arithmetic. */
export function verifyAgainstInteger(
  width: number,
  height: number,
  denom: number,
  layers: readonly Layer[],
  intOutput: Uint32Array,
): VerifyReport {
  const frac = recomputeFractional(width, height, denom, layers);
  const coverage = coverageMap(width, height, layers);
  const report: VerifyReport = {
    mismatches: [],
    extrema: computeExtrema(intOutput),
    overlapPixels: 0,
    overlapMismatches: 0,
    dirtyTransparentPixels: 0,
    invariantViolations: 0,
    maxRoundingError: Frac.zero(),
  };
  const grid = BigInt(denom);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const o = (y * width + x) * 4;
      const intPx = [intOutput[o], intOutput[o + 1], intOutput[o + 2], intOutput[o + 3]];
      const fracPx = [frac[o], frac[o + 1], frac[o + 2], frac[o + 3]];
      const isOverlap = coverage[y * width + x] >= 2;
      if (isOverlap) report.overlapPixels++;
      if (intPx.some((v, c) => v !== fracPx[c])) {
        report.mismatches.push({ x, y, int: intPx, frac: fracPx });
        if (isOverlap) report.overlapMismatches++;
      }
      if (intPx[3] === 0 && (intPx[0] !== 0 || intPx[1] !== 0 || intPx[2] !== 0)) {
        report.dirtyTransparentPixels++;
      }
      if (intPx[0] > intPx[3] || intPx[1] > intPx[3] || intPx[2] > intPx[3]) {
        report.invariantViolations++;
      }
      // Error of the integer pipeline vs. the exact unrounded composite.
      const exact = compositePixelExact(layers, denom, x, y, false);
      const channels: [number, Frac][] = [
        [intPx[0], exact.r],
        [intPx[1], exact.g],
        [intPx[2], exact.b],
        [intPx[3], exact.a],
      ];
      for (const [intVal, exactVal] of channels) {
        const intFrac = Frac.of(BigInt(intVal)).mul(Frac.of(1n, grid));
        const err = intFrac.sub(exactVal).abs();
        if (err.cmp(report.maxRoundingError) > 0) report.maxRoundingError = err;
      }
    }
  }
  return report;
}
