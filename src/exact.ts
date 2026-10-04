import { roundHalfEvenBig } from "./rounding.js";
import type { Layer } from "./layer.js";
import type { Pixel } from "./pixel.js";

/**
 * Independent verification path: the same source-over formula and the
 * same per-layer half-even rounding, but computed with exact BigInt
 * rational arithmetic instead of the fast Uint pipeline. Any divergence
 * between the two signals an overflow or rounding bug in the fast path.
 */
export function blendOverExact(den: number, src: Pixel, dst: Pixel): Pixel {
  const d = BigInt(den);
  const sa = BigInt(src[3]);
  const da = BigInt(dst[3]);
  const inv = d - sa;
  const a = sa + roundHalfEvenBig(da * inv, d);
  const r = BigInt(src[0]) + roundHalfEvenBig(BigInt(dst[0]) * inv, d);
  const g = BigInt(src[1]) + roundHalfEvenBig(BigInt(dst[1]) * inv, d);
  const b = BigInt(src[2]) + roundHalfEvenBig(BigInt(dst[2]) * inv, d);
  if (a === 0n) return [0, 0, 0, 0];
  return [Number(r), Number(g), Number(b), Number(a)];
}

/** Whole-canvas recompute of a layer stack via exact arithmetic. */
export function compositeExact(layers: readonly Layer[], width: number, height: number, den: number): Uint16Array {
  const out = new Uint16Array(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      let acc: Pixel = [0, 0, 0, 0];
      for (const layer of layers) {
        acc = blendOverExact(den, layer.getPixel(x, y), acc);
      }
      const i = (y * width + x) * 4;
      out[i] = acc[0];
      out[i + 1] = acc[1];
      out[i + 2] = acc[2];
      out[i + 3] = acc[3];
    }
  }
  return out;
}

export interface ChannelExtrema {
  readonly min: readonly [number, number, number, number];
  readonly max: readonly [number, number, number, number];
}

/** Min/max of every channel across a composited buffer. */
export function extrema(buf: Uint16Array): ChannelExtrema {
  const min: [number, number, number, number] = [Infinity, Infinity, Infinity, Infinity];
  const max: [number, number, number, number] = [-Infinity, -Infinity, -Infinity, -Infinity];
  for (let i = 0; i < buf.length; i += 4) {
    for (let c = 0; c < 4; c++) {
      const v = buf[i + c];
      if (v < min[c]) min[c] = v;
      if (v > max[c]) max[c] = v;
    }
  }
  return { min, max };
}
