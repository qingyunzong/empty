import { Layer, type Entry } from './layer.js';
import { keyFor, normalizePath } from './paths.js';

export interface ResolverOptions {
  /** Layers in priority order: index 0 is the top (highest priority) layer. */
  layers?: Layer[];
  /** Case rules are specified by the caller; defaults to case-sensitive. */
  caseSensitive?: boolean;
}

export interface Stat {
  readonly kind: 'file' | 'dir';
  /** Name of the layer that provided the winning entry; null for the root. */
  readonly layer: string | null;
}

function errno(code: string, message: string): Error {
  return Object.assign(new Error(`${code}: ${message}`), { code });
}

/**
 * Reads a merged view over several layers, highest priority first.
 *
 * Semantics:
 * - The topmost exact entry for a path wins; a tombstone means "not found".
 * - A tombstone, a file, or an opaque directory at path P in layer L shadows
 *   the whole subtree below P in every layer below L. Entries in L itself
 *   (children newly created in the current layer) remain visible.
 * - readdir() and readFile()/stat() share the same visibility rules, so a
 *   listed name can always be stat'ed, and a readable file is always listed.
 */
export class LayeredResolver {
  readonly caseSensitive: boolean;
  readonly #layers: Layer[] = [];
  #frozen = false;

  constructor(options: ResolverOptions = {}) {
    this.caseSensitive = options.caseSensitive ?? true;
    for (const layer of options.layers ?? []) {
      if (layer.caseSensitive !== this.caseSensitive) {
        throw new Error(
          `layer "${layer.name}" case sensitivity does not match the resolver`,
        );
      }
      this.#layers.push(layer);
    }
  }

  get frozen(): boolean {
    return this.#frozen;
  }

  /** Live layers, top (index 0) to bottom. Mutating them mutates the view. */
  get layers(): readonly Layer[] {
    return this.#layers;
  }

  /** The top layer, which receives writes made through the resolver. */
  get topLayer(): Layer | undefined {
    return this.#layers[0];
  }

  /** Appends a new layer below all existing ones and returns it. */
  addLayer(name?: string): Layer {
    this.#assertMutable();
    const layer = new Layer(name ?? `layer${this.#layers.length}`, {
      caseSensitive: this.caseSensitive,
    });
    this.#layers.push(layer);
    return layer;
  }

  stat(path: string): Stat | undefined {
    const segments = normalizePath(path);
    if (segments.length === 0) return { kind: 'dir', layer: null };
    const hit = this.#resolve(segments);
    if (!hit || hit.entry.kind === 'tombstone') return undefined;
    return {
      kind: hit.entry.kind === 'file' ? 'file' : 'dir',
      layer: this.#layers[hit.layerIndex]?.name ?? null,
    };
  }

  exists(path: string): boolean {
    return this.stat(path) !== undefined;
  }

  readFile(path: string): string {
    const segments = normalizePath(path);
    const hit = segments.length === 0 ? undefined : this.#resolve(segments);
    if (!hit || hit.entry.kind === 'tombstone') {
      throw errno('ENOENT', `no such file: ${path}`);
    }
    if (hit.entry.kind === 'dir') {
      throw errno('EISDIR', `is a directory: ${path}`);
    }
    return hit.entry.content;
  }

  readdir(path: string): string[] {
    const segments = normalizePath(path);
    if (segments.length > 0) {
      const hit = this.#resolve(segments);
      if (!hit || hit.entry.kind === 'tombstone') {
        throw errno('ENOENT', `no such directory: ${path}`);
      }
      if (hit.entry.kind === 'file') {
        throw errno('ENOTDIR', `not a directory: ${path}`);
      }
    }
    const depth = segments.length;
    const names = new Map<string, string>(); // folded child key -> display name
    for (let layerIndex = 0; layerIndex < this.#layers.length; layerIndex++) {
      const layer = this.#layers[layerIndex];
      if (!layer) continue;
      for (const stored of layer.values()) {
        if (stored.segments.length !== depth + 1) continue;
        if (stored.entry.kind === 'tombstone') continue;
        if (!this.#isPrefixOf(segments, stored.segments)) continue;
        if (!this.#isVisible(stored.segments, layerIndex)) continue;
        const key = keyFor(stored.segments, this.caseSensitive);
        const display = stored.segments[depth];
        if (display !== undefined && !names.has(key)) names.set(key, display);
      }
    }
    return [...names.values()].sort();
  }

  /** Writes a file into the top layer, creating parent directories there. */
  writeFile(path: string, content: string): void {
    this.#assertMutable();
    this.#writableLayer().writeFile(path, content);
  }

  /** Creates a directory (and missing parents) in the top layer. */
  mkdir(path: string): void {
    this.#assertMutable();
    this.#writableLayer().mkdir(path);
  }

  /** Deletes a path by writing a tombstone into the top layer. */
  remove(path: string): void {
    this.#assertMutable();
    if (!this.stat(path)) {
      throw errno('ENOENT', `no such path: ${path}`);
    }
    this.#writableLayer().remove(path);
  }

  /**
   * Returns an immutable snapshot: every layer is cloned and frozen, so
   * later writes to this resolver (or directly to its layers) do not leak
   * into the snapshot, and any write through the snapshot throws EFROZEN.
   */
  snapshot(): LayeredResolver {
    const snap = new LayeredResolver({ caseSensitive: this.caseSensitive });
    for (const layer of this.#layers) {
      const copy = layer.clone();
      copy.freeze();
      snap.#layers.push(copy);
    }
    snap.#frozen = true;
    return snap;
  }

  /**
   * Topmost exact entry wins. While scanning from the top, a layer that
   * shadows an ancestor of the path (tombstone, file, or opaque directory)
   * hides the path in every lower layer, so the search stops there.
   */
  #resolve(segments: readonly string[]): { entry: Entry; layerIndex: number } | undefined {
    for (let layerIndex = 0; layerIndex < this.#layers.length; layerIndex++) {
      const layer = this.#layers[layerIndex];
      if (!layer) continue;
      const hit = layer.getByKey(keyFor(segments, this.caseSensitive));
      if (hit) return { entry: hit.entry, layerIndex };
      if (this.#shadowedByLayer(segments, layer)) return undefined;
    }
    return undefined;
  }

  /** True if the layer shadows some strict ancestor of the path. */
  #shadowedByLayer(segments: readonly string[], layer: Layer): boolean {
    for (let depth = 1; depth < segments.length; depth++) {
      const ancestor = layer.getByKey(keyFor(segments.slice(0, depth), this.caseSensitive));
      if (ancestor && LayeredResolver.#shadowsBelow(ancestor.entry)) return true;
    }
    return false;
  }

  static #shadowsBelow(entry: Entry): boolean {
    return entry.kind !== 'dir' || entry.opaque;
  }

  /**
   * A stored entry is visible iff no higher-priority layer owns the exact
   * same path (topmost wins) and no higher-priority layer shadows one of
   * its ancestors.
   */
  #isVisible(segments: readonly string[], layerIndex: number): boolean {
    const key = keyFor(segments, this.caseSensitive);
    for (let upper = 0; upper < layerIndex; upper++) {
      const layer = this.#layers[upper];
      if (!layer) continue;
      if (layer.getByKey(key)) return false;
      if (this.#shadowedByLayer(segments, layer)) return false;
    }
    return true;
  }

  #isPrefixOf(parent: readonly string[], child: readonly string[]): boolean {
    if (parent.length >= child.length) return false;
    for (let index = 0; index < parent.length; index++) {
      const a = parent[index];
      const b = child[index];
      if (a === undefined || b === undefined) return false;
      if (this.caseSensitive ? a !== b : a.toLowerCase() !== b.toLowerCase()) return false;
    }
    return true;
  }

  #writableLayer(): Layer {
    const top = this.#layers[0];
    if (!top) {
      throw new Error('resolver has no layers; add one with addLayer() first');
    }
    return top;
  }

  #assertMutable(): void {
    if (this.#frozen) {
      throw errno('EFROZEN', 'resolver snapshot is immutable');
    }
  }
}
