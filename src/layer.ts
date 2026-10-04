import { keyFor, normalizePath } from './paths.js';

/**
 * A file carries its content; a directory may be `opaque`, meaning it was
 * re-created on top of a tombstone and therefore shadows the whole subtree
 * of every lower-priority layer; a tombstone marks a deletion and shadows
 * the path (and everything below it) in lower-priority layers.
 */
export type Entry =
  | { readonly kind: 'file'; readonly content: string }
  | { readonly kind: 'dir'; readonly opaque: boolean }
  | { readonly kind: 'tombstone' };

export interface StoredEntry {
  /** Original (display) segments as written; lookups use the folded key. */
  readonly segments: readonly string[];
  readonly entry: Entry;
}

function errno(code: string, message: string): Error {
  return Object.assign(new Error(`${code}: ${message}`), { code });
}

/**
 * One priority layer of the overlay. Entries are stored in a flat map keyed
 * by the case-folded canonical path, so lookups are O(1) and case rules are
 * fixed per layer (and must match the resolver that reads the layer).
 */
export class Layer {
  readonly name: string;
  readonly caseSensitive: boolean;
  readonly #entries = new Map<string, StoredEntry>();
  #frozen = false;

  constructor(name: string, options: { caseSensitive?: boolean } = {}) {
    this.name = name;
    this.caseSensitive = options.caseSensitive ?? true;
  }

  get frozen(): boolean {
    return this.#frozen;
  }

  get size(): number {
    return this.#entries.size;
  }

  /** Makes the layer immutable; used by snapshots. */
  freeze(): void {
    this.#frozen = true;
  }

  keyOf(segments: readonly string[]): string {
    return keyFor(segments, this.caseSensitive);
  }

  getByKey(key: string): StoredEntry | undefined {
    return this.#entries.get(key);
  }

  get(path: string): StoredEntry | undefined {
    return this.#entries.get(this.keyOf(normalizePath(path)));
  }

  *values(): IterableIterator<StoredEntry> {
    yield* this.#entries.values();
  }

  writeFile(path: string, content: string): void {
    this.#assertMutable();
    const segments = normalizePath(path);
    if (segments.length === 0) {
      throw errno('EISDIR', `cannot write a file at the root: ${path}`);
    }
    this.#ensureParents(segments);
    const key = this.keyOf(segments);
    if (this.#entries.get(key)?.entry.kind === 'dir') {
      throw errno('EISDIR', `is a directory: ${path}`);
    }
    this.#entries.set(key, { segments: [...segments], entry: { kind: 'file', content } });
  }

  mkdir(path: string): void {
    this.#assertMutable();
    const segments = normalizePath(path);
    if (segments.length === 0) return; // root always exists
    this.#ensureParents(segments);
    const key = this.keyOf(segments);
    const existing = this.#entries.get(key);
    if (!existing) {
      this.#entries.set(key, { segments: [...segments], entry: { kind: 'dir', opaque: false } });
    } else if (existing.entry.kind === 'tombstone') {
      // Re-creating a deleted directory: the new directory is opaque, so the
      // tombstone keeps shadowing lower subtrees while children created in
      // this layer from now on stay visible.
      this.#entries.set(key, { segments: [...segments], entry: { kind: 'dir', opaque: true } });
    } else if (existing.entry.kind === 'file') {
      throw errno('EEXIST', `a file already exists at: ${path}`);
    }
  }

  /**
   * Deletes a path from this layer's point of view: own entries below the
   * path are dropped and a tombstone is written, which shadows the path and
   * its whole subtree in every lower-priority layer.
   */
  remove(path: string): void {
    this.#assertMutable();
    const segments = normalizePath(path);
    if (segments.length === 0) {
      throw errno('EINVAL', 'cannot remove the root');
    }
    const key = this.keyOf(segments);
    const prefix = `${key}/`;
    for (const childKey of [...this.#entries.keys()]) {
      if (childKey.startsWith(prefix)) this.#entries.delete(childKey);
    }
    this.#entries.set(key, { segments: [...segments], entry: { kind: 'tombstone' } });
  }

  /** Deep-enough copy: stored entries are immutable values, so they are shared. */
  clone(): Layer {
    const copy = new Layer(this.name, { caseSensitive: this.caseSensitive });
    for (const [key, stored] of this.#entries) {
      copy.#entries.set(key, stored);
    }
    return copy;
  }

  #assertMutable(): void {
    if (this.#frozen) {
      throw errno('EFROZEN', `layer "${this.name}" is frozen (immutable snapshot)`);
    }
  }

  #ensureParents(segments: readonly string[]): void {
    for (let depth = 1; depth < segments.length; depth++) {
      const ancestor = segments.slice(0, depth);
      const key = this.keyOf(ancestor);
      const existing = this.#entries.get(key);
      if (!existing) {
        this.#entries.set(key, { segments: ancestor, entry: { kind: 'dir', opaque: false } });
      } else if (existing.entry.kind === 'tombstone') {
        this.#entries.set(key, { segments: ancestor, entry: { kind: 'dir', opaque: true } });
      } else if (existing.entry.kind === 'file') {
        throw errno('ENOTDIR', `not a directory: /${ancestor.join('/')}`);
      }
    }
  }
}
