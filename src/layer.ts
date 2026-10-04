import { makePixel, TRANSPARENT, type Pixel } from "./pixel.js";

export interface Rect {
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
}

export function clampRect(rect: Rect, width: number, height: number): Rect {
  const x = Math.max(0, Math.min(width, rect.x));
  const y = Math.max(0, Math.min(height, rect.y));
  const r = Math.max(0, Math.min(width, rect.x + rect.w));
  const b = Math.max(0, Math.min(height, rect.y + rect.h));
  return { x, y, w: r - x, h: b - y };
}

export function unionRect(a: Rect, b: Rect): Rect {
  const x = Math.min(a.x, b.x);
  const y = Math.min(a.y, b.y);
  return {
    x,
    y,
    w: Math.max(a.x + a.w, b.x + b.w) - x,
    h: Math.max(a.y + a.h, b.y + b.h) - y,
  };
}

export function rectArea(rect: Rect): number {
  return rect.w * rect.h;
}

/**
 * An immutable w*h grid of premultiplied pixels, stored as numerator
 * quadruples (r, g, b, a) over the shared denominator `den`.
 * Updates return new Layer instances; existing ones never change.
 */
export class Layer {
  readonly data: Uint16Array;

  constructor(
    readonly width: number,
    readonly height: number,
    readonly den: number,
    data?: Uint16Array,
  ) {
    this.data = data ? new Uint16Array(data) : new Uint16Array(width * height * 4);
  }

  static filled(width: number, height: number, den: number, px: Pixel): Layer {
    const layer = new Layer(width, height, den);
    const p = makePixel(den, px[0], px[1], px[2], px[3]);
    for (let i = 0; i < layer.data.length; i += 4) {
      layer.data[i] = p[0];
      layer.data[i + 1] = p[1];
      layer.data[i + 2] = p[2];
      layer.data[i + 3] = p[3];
    }
    return layer;
  }

  getPixel(x: number, y: number): Pixel {
    const i = (y * this.width + x) * 4;
    return [this.data[i], this.data[i + 1], this.data[i + 2], this.data[i + 3]];
  }

  /**
   * Return a new Layer with `rect` replaced by pixels from `paint`
   * (a constant pixel or a per-pixel function). `this` is untouched.
   * Every written pixel is normalised, so transparent pixels can never
   * carry residual colour.
   */
  withRect(rect: Rect, paint: Pixel | ((x: number, y: number) => Pixel)): Layer {
    const r = clampRect(rect, this.width, this.height);
    const next = new Uint16Array(this.data);
    for (let y = r.y; y < r.y + r.h; y++) {
      for (let x = r.x; x < r.x + r.w; x++) {
        const raw = typeof paint === "function" ? paint(x, y) : paint;
        const p = makePixel(this.den, raw[0], raw[1], raw[2], raw[3]);
        const i = (y * this.width + x) * 4;
        next[i] = p[0];
        next[i + 1] = p[1];
        next[i + 2] = p[2];
        next[i + 3] = p[3];
      }
    }
    return new Layer(this.width, this.height, this.den, next);
  }
}

export const EMPTY_RECT: Rect = Object.freeze({ x: 0, y: 0, w: 0, h: 0 });
export { TRANSPARENT };
