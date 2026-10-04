import { blendOver } from "./blend.js";
import { TRANSPARENT, type Pixel } from "./pixel.js";
import type { LayerDocument, Snapshot } from "./document.js";
import { rectArea, type Rect } from "./layer.js";

export interface RenderResult {
  /** Premultiplied numerator quadruples, w*h*4 entries. */
  readonly output: Uint16Array;
  /** Region actually recomputed this render; null when fully cached. */
  readonly region: Rect | null;
}

/**
 * Renders document snapshots. Between compatible versions only the dirty
 * rectangle is recomposited; untouched output pixels are carried over
 * byte-for-byte. Structural changes fall back to a full recompute.
 */
export class Compositor {
  private lastVersion = -1;
  private lastOutput: Uint16Array | null = null;
  private lastLayerCount = 0;
  /** Pixels recomputed by the most recent render (diagnostic). */
  pixelsRecomputed = 0;

  constructor(
    readonly width: number,
    readonly height: number,
    readonly den: number = 255,
  ) {}

  render(doc: LayerDocument, version: number = doc.currentVersion): RenderResult {
    const snap = doc.snapshot(version);
    if (this.lastOutput !== null && version === this.lastVersion) {
      this.pixelsRecomputed = 0;
      return { output: new Uint16Array(this.lastOutput), region: null };
    }
    const dirty =
      this.lastOutput !== null &&
      version > this.lastVersion &&
      snap.layers.length === this.lastLayerCount
        ? doc.dirtyBetween(this.lastVersion, version)
        : null;

    let output: Uint16Array;
    let region: Rect | null;
    if (this.lastOutput !== null && dirty !== null) {
      output = new Uint16Array(this.lastOutput);
      if (rectArea(dirty) > 0) {
        this.compositeRegion(snap, dirty, output);
        region = dirty;
      } else {
        region = null;
      }
    } else {
      output = new Uint16Array(this.width * this.height * 4);
      const full: Rect = { x: 0, y: 0, w: this.width, h: this.height };
      this.compositeRegion(snap, full, output);
      region = full;
    }
    this.pixelsRecomputed = region === null ? 0 : rectArea(region);
    this.lastVersion = version;
    this.lastOutput = new Uint16Array(output);
    this.lastLayerCount = snap.layers.length;
    return { output, region };
  }

  /** Independent whole-canvas recompute, ignoring all caches. */
  fullRecompute(doc: LayerDocument, version: number = doc.currentVersion): Uint16Array {
    const output = new Uint16Array(this.width * this.height * 4);
    this.compositeRegion(doc.snapshot(version), { x: 0, y: 0, w: this.width, h: this.height }, output);
    return output;
  }

  private compositeRegion(snap: Snapshot, rect: Rect, out: Uint16Array): void {
    for (let y = rect.y; y < rect.y + rect.h; y++) {
      for (let x = rect.x; x < rect.x + rect.w; x++) {
        let acc: Pixel = TRANSPARENT;
        for (let l = 0; l < snap.layers.length; l++) {
          acc = blendOver(this.den, snap.layers[l].getPixel(x, y), acc);
        }
        const i = (y * this.width + x) * 4;
        out[i] = acc[0];
        out[i + 1] = acc[1];
        out[i + 2] = acc[2];
        out[i + 3] = acc[3];
      }
    }
  }
}
