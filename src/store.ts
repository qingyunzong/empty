export const BUCKET_COUNT = 16;

export function bucketOf(key: number, bucketCount: number = BUCKET_COUNT): number {
  if (!Number.isSafeInteger(key)) {
    throw new RangeError(`key must be a safe integer, got ${key}`);
  }
  return ((key % bucketCount) + bucketCount) % bucketCount;
}

export interface LiveEntry {
  kind: "live";
  key: number;
  value: Uint8Array;
}

export interface TombstoneEntry {
  kind: "tombstone";
  key: number;
}

export type BucketEntry = LiveEntry | TombstoneEntry;

/**
 * Versioned integer-keyed store. Every mutation bumps `version`.
 * Deletions leave tombstones so that "deleted" is distinguishable from
 * "never existed" during reconciliation.
 */
export class Store {
  private readonly live = new Map<number, Uint8Array>();
  private readonly tombstones = new Set<number>();
  private ver = 0;

  get version(): number {
    return this.ver;
  }

  set(key: number, value: Uint8Array): void {
    this.live.set(key, value);
    this.tombstones.delete(key);
    this.ver++;
  }

  delete(key: number): boolean {
    if (!this.live.has(key)) return false;
    this.live.delete(key);
    this.tombstones.add(key);
    this.ver++;
    return true;
  }

  /** Apply a remote entry verbatim, keeping tombstones so digests converge. */
  apply(entry: BucketEntry): void {
    if (entry.kind === "live") {
      this.live.set(entry.key, entry.value);
      this.tombstones.delete(entry.key);
    } else {
      this.live.delete(entry.key);
      this.tombstones.add(entry.key);
    }
    this.ver++;
  }

  /** Remove a key entirely (no tombstone) so divergent local state converges. */
  purge(key: number): void {
    if (this.live.delete(key) || this.tombstones.delete(key)) this.ver++;
  }

  has(key: number): boolean {
    return this.live.has(key);
  }

  get(key: number): Uint8Array | undefined {
    return this.live.get(key);
  }

  /** Live entries + tombstones of one bucket, sorted by key ascending. */
  entriesInBucket(index: number, bucketCount: number = BUCKET_COUNT): BucketEntry[] {
    const out: BucketEntry[] = [];
    for (const [key, value] of this.live) {
      if (bucketOf(key, bucketCount) === index) out.push({ kind: "live", key, value });
    }
    for (const key of this.tombstones) {
      if (bucketOf(key, bucketCount) === index) out.push({ kind: "tombstone", key });
    }
    out.sort((a, b) => a.key - b.key);
    return out;
  }

  /** All live entries (no tombstones), sorted by key ascending. */
  liveEntries(): Array<[number, Uint8Array]> {
    return [...this.live.entries()].sort((a, b) => a[0] - b[0]);
  }
}
