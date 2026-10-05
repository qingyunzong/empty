/**
 * Composites a stack of layers (bottom -> top) onto a canvas using
 * per-layer round-half-to-even source-over blending.
 *
 * Output is stored in immutable tiles; each commit produces a new version
 * whose tiles structurally share with the previous version wherever the
 * output did not change. Rectangle updates therefore only rewrite the
 * affected output tiles, and every older version stays readable.
 */

import { Pixel, TRANSPARENT, blendPixel } from "./pixel.js";
import { Layer, Rect, rectsIntersect } from "./layer.js";

export const TILE_SIZE = 16;

class OutputVersion {
  constructor(
    readonly id: number,
    readonly tilesX: number,
    readonly tilesY: number,
    /** tilesY * tilesX entries; each tile is an immutable Uint32Array. */
    readonly tiles: ReadonlyArray<Uint32Array>,
  ) {}
}

export class Compositor {
  readonly width: number;
  readonly height: number;
  readonly denom: number;
  private layers: Layer[] = [];
  private versions: OutputVersion[] = [];
  private readonly tilesX: number;
  private readonly tilesY: number;

  constructor(width: number, height: number, denom: number) {
    if (width <= 0 || height <= 0) throw new RangeError("canvas must be non-empty");
    this.width = width;
    this.height = height;
    this.denom = denom;
    this.tilesX = Math.ceil(width / TILE_SIZE);
    this.tilesY = Math.ceil(height / TILE_SIZE);
  }

  /** Append a layer on top of the stack. Takes effect on the next commit. */
  addLayer(layer: Layer): void {
    if (layer.denom !== this.denom) {
      throw new RangeError("layer denominator does not match compositor");
    }
    this.layers.push(layer);
  }

  layerCount(): number {
    return this.layers.length;
  }

  versionCount(): number {
    return this.versions.length;
  }

  /** Composite one canvas pixel by folding the layer stack bottom-up. */
  private compositePixel(x: number, y: number): Pixel {
    let acc: Pixel = TRANSPARENT;
    for (const layer of this.layers) {
      const lx = x - layer.x;
      const ly = y - layer.y;
      if (lx < 0 || ly < 0 || lx >= layer.width || ly >= layer.height) continue;
      acc = blendPixel(layer.getPixel(lx, ly), acc, this.denom);
    }
    return acc;
  }

  private tileIndex(tx: number, ty: number): number {
    return ty * this.tilesX + tx;
  }

  /** Recompute the pixels of `rect` (canvas space) into `tile`. */
  private renderTileRect(tile: Uint32Array, tx: number, ty: number, rect: Rect): void {
    const x0 = Math.max(rect.x, tx * TILE_SIZE);
    const y0 = Math.max(rect.y, ty * TILE_SIZE);
    const x1 = Math.min(rect.x + rect.width, (tx + 1) * TILE_SIZE, this.width);
    const y1 = Math.min(rect.y + rect.height, (ty + 1) * TILE_SIZE, this.height);
    for (let y = y0; y < y1; y++) {
      for (let x = x0; x < x1; x++) {
        const px = this.compositePixel(x, y);
        const i = ((y - ty * TILE_SIZE) * TILE_SIZE + (x - tx * TILE_SIZE)) * 4;
        tile[i] = px.r;
        tile[i + 1] = px.g;
        tile[i + 2] = px.b;
        tile[i + 3] = px.a;
      }
    }
  }

  private commit(affected: Rect): number {
    const prev = this.versions[this.versions.length - 1];
    const tiles: Uint32Array[] = new Array(this.tilesX * this.tilesY);
    for (let ty = 0; ty < this.tilesY; ty++) {
      for (let tx = 0; tx < this.tilesX; tx++) {
        const idx = this.tileIndex(tx, ty);
        const tileRect: Rect = {
          x: tx * TILE_SIZE,
          y: ty * TILE_SIZE,
          width: TILE_SIZE,
          height: TILE_SIZE,
        };
        const hit = rectsIntersect(tileRect, affected);
        if (!hit && prev) {
          // Unaffected tile: share the previous version's tile by reference.
          tiles[idx] = prev.tiles[idx];
          continue;
        }
        // Affected tile (or first commit): copy the old contents (if any)
        // and re-render the intersection with the dirty rect; without a
        // previous version the whole tile must be rendered.
        const tile = prev ? new Uint32Array(prev.tiles[idx]) : new Uint32Array(TILE_SIZE * TILE_SIZE * 4);
        this.renderTileRect(tile, tx, ty, prev ? (hit ?? affected) : tileRect);
        tiles[idx] = tile;
      }
    }
    const version = new OutputVersion(this.versions.length, this.tilesX, this.tilesY, tiles);
    this.versions.push(version);
    return version.id;
  }

  /** Full-canvas recompute; returns the new version id. */
  composite(): number {
    return this.commit({ x: 0, y: 0, width: this.width, height: this.height });
  }

  /**
   * Replace a rect of one layer (layer-local coordinates) and recompute
   * only the affected output tiles. Returns the new version id; all older
   * versions remain readable.
   */
  updateRect(layerIndex: number, rect: Rect, pixels: ArrayLike<number>): number {
    const layer = this.layers[layerIndex];
    if (!layer) throw new RangeError(`no layer at index ${layerIndex}`);
    const updated = layer.withRect(rect, pixels);
    this.layers[layerIndex] = updated;
    const canvasRect: Rect = {
      x: layer.x + rect.x,
      y: layer.y + rect.y,
      width: rect.width,
      height: rect.height,
    };
    const affected = rectsIntersect(canvasRect, {
      x: 0,
      y: 0,
      width: this.width,
      height: this.height,
    });
    if (!affected) {
      // Update landed entirely outside the canvas: still record a version
      // (the layer changed) but reuse every tile.
      return this.commit({ x: 0, y: 0, width: 0, height: 0 });
    }
    return this.commit(affected);
  }

  private tileOf(version: OutputVersion, x: number, y: number): { tile: Uint32Array; index: number } {
    const tx = Math.floor(x / TILE_SIZE);
    const ty = Math.floor(y / TILE_SIZE);
    return {
      tile: version.tiles[this.tileIndex(tx, ty)],
      index: ((y - ty * TILE_SIZE) * TILE_SIZE + (x - tx * TILE_SIZE)) * 4,
    };
  }

  /** Read one composited pixel from any committed version. */
  getPixel(versionId: number, x: number, y: number): Pixel {
    const version = this.versions[versionId];
    if (!version) throw new RangeError(`no version ${versionId}`);
    if (x < 0 || y < 0 || x >= this.width || y >= this.height) {
      throw new RangeError("canvas coordinates out of bounds");
    }
    const { tile, index } = this.tileOf(version, x, y);
    return { r: tile[index], g: tile[index + 1], b: tile[index + 2], a: tile[index + 3] };
  }

  /** Copy the full composited output of a version (RGBA numerators). */
  readVersion(versionId: number): Uint32Array {
    const version = this.versions[versionId];
    if (!version) throw new RangeError(`no version ${versionId}`);
    const out = new Uint32Array(this.width * this.height * 4);
    for (let y = 0; y < this.height; y++) {
      for (let x = 0; x < this.width; x++) {
        const { tile, index } = this.tileOf(version, x, y);
        const o = (y * this.width + x) * 4;
        out[o] = tile[index];
        out[o + 1] = tile[index + 1];
        out[o + 2] = tile[index + 2];
        out[o + 3] = tile[index + 3];
      }
    }
    return out;
  }

  /**
   * Test/diagnostic helper: how many output tiles are shared by reference
   * between two versions (i.e. provably untouched by the update).
   */
  countSharedTiles(versionA: number, versionB: number): number {
    const a = this.versions[versionA];
    const b = this.versions[versionB];
    if (!a || !b) throw new RangeError("unknown version");
    let shared = 0;
    for (let i = 0; i < a.tiles.length; i++) {
      if (a.tiles[i] === b.tiles[i]) shared++;
    }
    return shared;
  }

  totalTiles(): number {
    return this.tilesX * this.tilesY;
  }
}
