import { baseName, normalizePath } from './path.js';

/**
 * A directory tombstone is stored as { kind: 'tombstone', target: 'dir' }.
 * When the same layer later recreates entries below that directory, the
 * tombstone becomes an opaque directory { kind: 'dir', opaque: true }:
 * the layer's own new children stay visible while lower layers' subtrees
 * remain hidden.
 */
export type Entry =
  | { readonly kind: 'file'; readonly data: Uint8Array }
  | { readonly kind: 'dir'; readonly opaque: boolean }
  | { readonly kind: 'tombstone'; readonly target: 'file' | 'dir' };

export interface Layer {
  readonly name: string;
  /** Look up one normalized path. */
  getEntry(path: string): Entry | undefined;
  /** Display names of immediate children (including tombstones). */
  children(path: string): string[];
  /** Optional immutable copy used by OverlayResolver.snapshot(). */
  snapshot?(): Layer;
}

interface StoredEntry {
  readonly entry: Entry;
  readonly displayName: string;
}

export class MemoryLayer implements Layer {
  readonly name: string;
  readonly caseSensitive: boolean;
  #entries = new Map<string, StoredEntry>();
  #frozen = false;

  constructor(name: string, caseSensitive = true) {
    this.name = name;
    this.caseSensitive = caseSensitive;
  }

  get frozen(): boolean {
    return this.#frozen;
  }

  /** Comparison form of a path under this layer's case rule. */
  key(path: string): string {
    const normalized = normalizePath(path);
    return this.caseSensitive ? normalized : normalized.toLowerCase();
  }

  /** All stored paths in comparison form (for debugging and tests). */
  keys(): string[] {
    return [...this.#entries.keys()];
  }

  #assertMutable(): void {
    if (this.#frozen) {
      throw new Error(`layer "${this.name}" is frozen (it belongs to a snapshot)`);
    }
  }

  /** Create missing parent directories, preserving raw display casing. */
  #ensureParents(rawNormalized: string): void {
    const segments = rawNormalized.split('/').filter((s) => s.length > 0);
    let rawPrefix = '';
    for (let i = 0; i < segments.length - 1; i++) {
      rawPrefix += '/' + segments[i];
      const key = this.key(rawPrefix);
      const existing = this.#entries.get(key);
      if (!existing) {
        this.#entries.set(key, {
          entry: { kind: 'dir', opaque: false },
          displayName: segments[i],
        });
      } else if (existing.entry.kind === 'tombstone') {
        // Recreating a directory over a dir tombstone keeps the barrier
        // against lower layers (opaque); a file tombstone is simply replaced.
        this.#entries.set(key, {
          entry: { kind: 'dir', opaque: existing.entry.target === 'dir' },
          displayName: segments[i],
        });
      }
    }
  }

  writeFile(path: string, data: Uint8Array | string): void {
    this.#assertMutable();
    const normalized = normalizePath(path);
    this.#ensureParents(normalized);
    const bytes =
      typeof data === 'string' ? new TextEncoder().encode(data) : data.slice();
    this.#entries.set(this.key(normalized), {
      entry: { kind: 'file', data: bytes },
      displayName: baseName(normalized),
    });
  }

  mkdir(path: string): void {
    this.#assertMutable();
    const normalized = normalizePath(path);
    this.#ensureParents(normalized);
    const key = this.key(normalized);
    const existing = this.#entries.get(key);
    if (existing?.entry.kind === 'dir') return;
    const opaque =
      existing?.entry.kind === 'tombstone' && existing.entry.target === 'dir';
    this.#entries.set(key, {
      entry: { kind: 'dir', opaque },
      displayName: baseName(normalized),
    });
  }

  /** Tombstone a file: hides a lower-layer file of the same path. */
  deleteFile(path: string): void {
    this.#assertMutable();
    const normalized = normalizePath(path);
    this.#ensureParents(normalized);
    this.#entries.set(this.key(normalized), {
      entry: { kind: 'tombstone', target: 'file' },
      displayName: baseName(normalized),
    });
  }

  /**
   * Tombstone a directory: hides the whole lower-layer subtree below `path`.
   * Entries created later in this same layer under `path` stay visible.
   */
  deleteDir(path: string): void {
    this.#assertMutable();
    const normalized = normalizePath(path);
    this.#ensureParents(normalized);
    const key = this.key(normalized);
    const prefix = key === '/' ? '/' : key + '/';
    for (const stored of [...this.#entries.keys()]) {
      if (stored.startsWith(prefix)) this.#entries.delete(stored);
    }
    this.#entries.set(key, {
      entry: { kind: 'tombstone', target: 'dir' },
      displayName: baseName(normalized),
    });
  }

  getEntry(path: string): Entry | undefined {
    return this.#entries.get(this.key(path))?.entry;
  }

  children(path: string): string[] {
    const key = this.key(path);
    const prefix = key === '/' ? '/' : key + '/';
    const out: string[] = [];
    for (const [storedKey, stored] of this.#entries) {
      if (!storedKey.startsWith(prefix)) continue;
      const rest = storedKey.slice(prefix.length);
      if (rest.length > 0 && !rest.includes('/')) out.push(stored.displayName);
    }
    return out;
  }

  /** Immutable copy: the returned layer is frozen and cannot be mutated. */
  snapshot(): MemoryLayer {
    const copy = new MemoryLayer(this.name, this.caseSensitive);
    copy.#entries = new Map(this.#entries);
    copy.#frozen = true;
    return copy;
  }
}
