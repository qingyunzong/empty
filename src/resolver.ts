import type { Entry, Layer } from './layer.js';
import { ancestorsOf, joinPath, normalizePath } from './path.js';

export interface OverlayOptions {
  /** Case rule for all path comparisons. Defaults to true. */
  caseSensitive?: boolean;
}

export type StatKind = 'file' | 'dir';

export type ScanOutcome =
  | 'hit-file'
  | 'hit-dir'
  | 'hit-opaque-dir'
  | 'tombstone-file'
  | 'tombstone-dir'
  | 'blocked-by-dir-tombstone'
  | 'miss';

export interface ScanStep {
  readonly layer: string;
  readonly outcome: ScanOutcome;
  /** Path within the layer that determined the outcome. */
  readonly at: string;
}

export interface ScanResult {
  readonly path: string;
  readonly found: StatKind | undefined;
  readonly winner: string | undefined;
  /** One step per consulted layer, highest priority first. */
  readonly trace: readonly ScanStep[];
}

/**
 * Resolves resources across priority-ordered layers: `layers[0]` is the
 * highest priority. A directory tombstone (or recreated opaque directory)
 * in layer i hides the whole subtree from layers below i, while entries
 * created in layer i itself under that directory stay visible.
 */
export class OverlayResolver {
  readonly caseSensitive: boolean;
  readonly #layers: Layer[];

  constructor(layers: Layer[], options: OverlayOptions = {}) {
    this.caseSensitive = options.caseSensitive ?? true;
    for (const layer of layers) {
      const layerRule = (layer as { caseSensitive?: boolean }).caseSensitive;
      if (layerRule !== undefined && layerRule !== this.caseSensitive) {
        throw new Error(
          `layer "${layer.name}" uses caseSensitive=${layerRule}, ` +
            `but the resolver uses caseSensitive=${this.caseSensitive}`,
        );
      }
    }
    this.#layers = layers.slice();
  }

  get layers(): readonly Layer[] {
    return this.#layers;
  }

  /** Comparison form of a path under the resolver's case rule. */
  key(path: string): string {
    const normalized = normalizePath(path);
    return this.caseSensitive ? normalized : normalized.toLowerCase();
  }

  static #isDirBarrier(entry: Entry | undefined): boolean {
    return (
      (entry?.kind === 'tombstone' && entry.target === 'dir') ||
      (entry?.kind === 'dir' && entry.opaque)
    );
  }

  #resolve(path: string): ScanResult & { entry: Entry | undefined } {
    const key = this.key(path);
    const ancestors = ancestorsOf(key);
    const trace: ScanStep[] = [];
    for (const layer of this.#layers) {
      const entry = layer.getEntry(key);
      if (entry) {
        if (entry.kind === 'file') {
          trace.push({ layer: layer.name, outcome: 'hit-file', at: key });
          return { path: key, found: 'file', winner: layer.name, trace, entry };
        }
        if (entry.kind === 'dir') {
          trace.push({
            layer: layer.name,
            outcome: entry.opaque ? 'hit-opaque-dir' : 'hit-dir',
            at: key,
          });
          return { path: key, found: 'dir', winner: layer.name, trace, entry };
        }
        trace.push({
          layer: layer.name,
          outcome: entry.target === 'dir' ? 'tombstone-dir' : 'tombstone-file',
          at: key,
        });
        return { path: key, found: undefined, winner: undefined, trace, entry: undefined };
      }
      const barrier = ancestors.find((ancestor) =>
        OverlayResolver.#isDirBarrier(layer.getEntry(ancestor)),
      );
      if (barrier !== undefined) {
        trace.push({ layer: layer.name, outcome: 'blocked-by-dir-tombstone', at: barrier });
        return { path: key, found: undefined, winner: undefined, trace, entry: undefined };
      }
      trace.push({ layer: layer.name, outcome: 'miss', at: key });
    }
    return { path: key, found: undefined, winner: undefined, trace, entry: undefined };
  }

  /** Layer-by-layer scan of `path`, for verifying mixed tombstones. */
  scan(path: string): ScanResult {
    const { entry: _entry, ...result } = this.#resolve(path);
    return result;
  }

  stat(path: string): StatKind | undefined {
    return this.#resolve(path).found;
  }

  exists(path: string): boolean {
    return this.stat(path) !== undefined;
  }

  readFile(path: string): Uint8Array | undefined {
    const { entry } = this.#resolve(path);
    if (entry?.kind !== 'file') return undefined;
    return entry.data.slice();
  }

  readTextFile(path: string): string | undefined {
    const data = this.readFile(path);
    return data === undefined ? undefined : new TextDecoder().decode(data);
  }

  /**
   * Union of immediate children across layers. A child tombstone hides
   * lower layers' entries with the same name; a directory tombstone stops
   * the merge after that layer's own children. Consistent with readFile:
   * every listed name resolves, and every resolvable child is listed.
   */
  listDir(path: string): string[] | undefined {
    const key = this.key(path);
    const ancestors = ancestorsOf(key);
    const merged = new Map<string, string>();
    const hidden = new Set<string>();
    let foundDir = false;
    let decided = false;

    for (const layer of this.#layers) {
      const entry = layer.getEntry(key);
      if (!decided && entry) {
        decided = true;
        if (entry.kind === 'file') return undefined;
        if (entry.kind === 'tombstone' && entry.target === 'file') return undefined;
      }
      if (entry?.kind === 'dir') foundDir = true;

      for (const childName of layer.children(key)) {
        const childKey = this.key(joinPath(key, childName));
        const childEntry = layer.getEntry(childKey);
        if (childEntry?.kind === 'tombstone') {
          // Hides lower layers only; higher layers already merged win.
          hidden.add(childKey);
          continue;
        }
        if (hidden.has(childKey) || merged.has(childKey)) continue;
        merged.set(childKey, childName);
      }

      if (OverlayResolver.#isDirBarrier(entry)) break;
      const barrier = ancestors.find((ancestor) =>
        OverlayResolver.#isDirBarrier(layer.getEntry(ancestor)),
      );
      if (barrier !== undefined) break;
    }

    if (!foundDir && merged.size === 0) return undefined;
    return [...merged.values()].sort();
  }

  /** Immutable view: layers are replaced by frozen snapshots where possible. */
  snapshot(): OverlayResolver {
    return new OverlayResolver(
      this.#layers.map((layer) => (layer.snapshot ? layer.snapshot() : layer)),
      { caseSensitive: this.caseSensitive },
    );
  }
}
