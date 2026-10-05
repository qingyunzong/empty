import { digestBytes, type Digest } from './digest.js';

/**
 * Content-addressed backup store. File contents are kept under their SHA-256
 * digest, so identical bytes are stored once and every digest recorded in the
 * journal doubles as a key into this store.
 */
export class BackupStore {
  private readonly items = new Map<Digest, Uint8Array>();

  /** Stores a copy of `content` and returns its digest (the lookup key). */
  put(content: Uint8Array): Digest {
    const key = digestBytes(content);
    if (!this.items.has(key)) {
      this.items.set(key, content.slice());
    }
    return key;
  }

  /** Returns a copy of the bytes stored under `key`. */
  get(key: Digest): Uint8Array {
    const content = this.items.get(key);
    if (content === undefined) {
      throw new Error(`backup missing for digest ${key}`);
    }
    return content.slice();
  }

  has(key: Digest): boolean {
    return this.items.has(key);
  }

  get size(): number {
    return this.items.size;
  }
}
