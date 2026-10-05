/**
 * An immutable, positioned layer of premultiplied integer-numerator pixels.
 * Updates produce new Layer objects; previously obtained layers stay
 * readable and unchanged.
 */

import { Pixel, TRANSPARENT, assertValidPixel, canonicalize } from "./pixel.js";

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export class Layer {
  /** Canvas-space position of the layer's top-left corner. */
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
  readonly denom: number;
  /** Row-major RGBA numerators, 4 entries per pixel, layer-local coords. */
  private readonly data: Uint32Array;

  private constructor(
    x: number,
    y: number,
    width: number,
    height: number,
    denom: number,
    data: Uint32Array,
  ) {
    this.x = x;
    this.y = y;
    this.width = width;
    this.height = height;
    this.denom = denom;
    this.data = data;
  }

  /**
   * Create a layer from raw RGBA numerator data (4 entries per pixel).
   * Every pixel is validated against the premultiplied invariant; fully
   * transparent pixels carrying residual color are silently canonicalized
   * to clean transparent (color channels zeroed).
   */
  static fromPixels(
    x: number,
    y: number,
    width: number,
    height: number,
    pixels: ArrayLike<number>,
    denom: number,
  ): Layer {
    if (width <= 0 || height <= 0) throw new RangeError("layer must be non-empty");
    if (pixels.length !== width * height * 4) {
      throw new RangeError(
        `expected ${width * height * 4} channel values, got ${pixels.length}`,
      );
    }
    const data = new Uint32Array(width * height * 4);
    for (let i = 0; i < width * height; i++) {
      const px: Pixel = {
        r: pixels[i * 4],
        g: pixels[i * 4 + 1],
        b: pixels[i * 4 + 2],
        a: pixels[i * 4 + 3],
      };
      const clean = canonicalize(px);
      assertValidPixel(clean, denom, `layer pixel ${i}`);
      data[i * 4] = clean.r;
      data[i * 4 + 1] = clean.g;
      data[i * 4 + 2] = clean.b;
      data[i * 4 + 3] = clean.a;
    }
    return new Layer(x, y, width, height, denom, data);
  }

  /** A fully transparent layer (all pixels clean transparent). */
  static transparent(
    x: number,
    y: number,
    width: number,
    height: number,
    denom: number,
  ): Layer {
    return new Layer(x, y, width, height, denom, new Uint32Array(width * height * 4));
  }

  getPixel(lx: number, ly: number): Pixel {
    if (lx < 0 || ly < 0 || lx >= this.width || ly >= this.height) {
      throw new RangeError("layer coordinates out of bounds");
    }
    const i = (ly * this.width + lx) * 4;
    return {
      r: this.data[i],
      g: this.data[i + 1],
      b: this.data[i + 2],
      a: this.data[i + 3],
    };
  }

  /** Canvas-space rectangle covered by this layer. */
  bounds(): Rect {
    return { x: this.x, y: this.y, width: this.width, height: this.height };
  }

  /**
   * Return a new Layer with the pixels inside `rect` (layer-local coords)
   * replaced by `pixels` (4 values per pixel, row-major over the rect).
   * This layer is left untouched, so older compositor versions that still
   * reference it remain valid.
   */
  withRect(rect: Rect, pixels: ArrayLike<number>): Layer {
    const { x, y, width, height } = rect;
    if (x < 0 || y < 0 || width <= 0 || height <= 0 ||
        x + width > this.width || y + height > this.height) {
      throw new RangeError("update rect outside layer bounds");
    }
    if (pixels.length !== width * height * 4) {
      throw new RangeError(
        `expected ${width * height * 4} channel values, got ${pixels.length}`,
      );
    }
    const data = new Uint32Array(this.data);
    for (let row = 0; row < height; row++) {
      for (let col = 0; col < width; col++) {
        const si = (row * width + col) * 4;
        const px: Pixel = {
          r: pixels[si],
          g: pixels[si + 1],
          b: pixels[si + 2],
          a: pixels[si + 3],
        };
        const clean = canonicalize(px);
        assertValidPixel(clean, this.denom, "update pixel");
        const di = ((y + row) * this.width + (x + col)) * 4;
        data[di] = clean.r;
        data[di + 1] = clean.g;
        data[di + 2] = clean.b;
        data[di + 3] = clean.a;
      }
    }
    return new Layer(this.x, this.y, this.width, this.height, this.denom, data);
  }
}

export function rectsIntersect(a: Rect, b: Rect): Rect | null {
  const x = Math.max(a.x, b.x);
  const y = Math.max(a.y, b.y);
  const right = Math.min(a.x + a.width, b.x + b.width);
  const bottom = Math.min(a.y + a.height, b.y + b.height);
  if (right <= x || bottom <= y) return null;
  return { x, y, width: right - x, height: bottom - y };
}

export function rectContains(r: Rect, x: number, y: number): boolean {
  return x >= r.x && x < r.x + r.width && y >= r.y && y < r.y + r.height;
}

export { TRANSPARENT };
