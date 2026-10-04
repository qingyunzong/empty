import { Layer, clampRect, unionRect, type Rect } from "./layer.js";
import type { Pixel } from "./pixel.js";

/** Immutable view of the layer stack at one version. */
export interface Snapshot {
  readonly version: number;
  readonly layers: readonly Layer[];
}

/**
 * Versioned stack of layers. Every mutation commits a new version and
 * never touches previous ones, so any earlier snapshot stays readable.
 */
export class LayerDocument {
  private readonly versions: Layer[][] = [[]];
  // dirty[i] describes how version i differs from version i-1:
  // a Rect for a pure pixel update, or null for a structural change.
  private readonly dirty: (Rect | null)[] = [null];

  constructor(
    readonly width: number,
    readonly height: number,
    readonly den: number = 255,
  ) {}

  get currentVersion(): number {
    return this.versions.length - 1;
  }

  get layerCount(): number {
    return this.versions[this.versions.length - 1].length;
  }

  addLayer(fill?: Pixel): number {
    const layer = fill
      ? Layer.filled(this.width, this.height, this.den, fill)
      : new Layer(this.width, this.height, this.den);
    this.versions.push([...this.versions[this.versions.length - 1], layer]);
    this.dirty.push(null);
    return this.versions[this.versions.length - 1].length - 1;
  }

  /** Paint `rect` of `layerIndex`; commits and returns the new version. */
  updateRect(
    layerIndex: number,
    rect: Rect,
    paint: Pixel | ((x: number, y: number) => Pixel),
  ): number {
    const current = this.versions[this.versions.length - 1];
    if (layerIndex < 0 || layerIndex >= current.length) {
      throw new RangeError(`no layer at index ${layerIndex}`);
    }
    const next = current.slice();
    next[layerIndex] = next[layerIndex].withRect(rect, paint);
    this.versions.push(next);
    this.dirty.push(clampRect(rect, this.width, this.height));
    return this.currentVersion;
  }

  /** Snapshot of any committed version; older versions stay readable. */
  snapshot(version: number = this.currentVersion): Snapshot {
    if (version < 0 || version > this.currentVersion) {
      throw new RangeError(`no version ${version}`);
    }
    return { version, layers: this.versions[version] };
  }

  /**
   * Union of pixel regions changed strictly after `fromVersion` up to and
   * including `toVersion`. Returns null when a structural change (layer
   * add/remove) intervened, meaning a full recompute is required.
   */
  dirtyBetween(fromVersion: number, toVersion: number): Rect | null {
    let acc: Rect | null = null;
    for (let v = fromVersion + 1; v <= toVersion; v++) {
      const d = this.dirty[v];
      if (d === null) return null;
      if (d.w === 0 || d.h === 0) continue;
      acc = acc === null ? d : unionRect(acc, d);
    }
    return acc ?? { x: 0, y: 0, w: 0, h: 0 };
  }
}
