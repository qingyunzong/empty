import { DigestFn, fnv1a32, mix32 } from "./hash.js";

/** A record inside a bucket. `value === null` is a deletion tombstone. */
export interface BucketRecord {
  key: number;
  value: Uint8Array | null;
}

/** Per-bucket summary exchanged at the start of a sync round. */
export interface BucketSummary {
  bucket: number;
  /** Number of entries (live records + tombstones) in the bucket. */
  count: number;
  /** Order-sensitive digest over sorted (key, tombstone-flag, value-digest). */
  digest: number;
}

/** Digest of an empty bucket: the bare seed, with count 0. */
export const EMPTY_BUCKET_DIGEST = 0x811c9dc5;

/** Marker mixed into the digest for tombstones, in place of a value digest. */
const TOMBSTONE_MARKER = 0xdeadbeaf;

/**
 * Versioned integer-key store. Deletions are kept as tombstones so that a
 * bucket that only contains tombstones is distinguishable from a bucket
 * that never held anything (different count and digest). Every mutation
 * bumps `version`; sync rounds are pinned to one version.
 */
export class Store {
  private entries = new Map<number, Uint8Array | null>();
  private currentVersion = 0;
  readonly bucketCount: number;
  readonly keySpaceSize: number;
  private readonly digestOf: DigestFn;

  constructor(bucketCount: number, keySpaceSize: number, digestOf: DigestFn = fnv1a32) {
    if (!Number.isInteger(bucketCount) || bucketCount <= 0) {
      throw new RangeError("bucketCount must be a positive integer");
    }
    if (!Number.isInteger(keySpaceSize) || keySpaceSize <= 0) {
      throw new RangeError("keySpaceSize must be a positive integer");
    }
    this.bucketCount = bucketCount;
    this.keySpaceSize = keySpaceSize;
    this.digestOf = digestOf;
  }

  get version(): number {
    return this.currentVersion;
  }

  /** Bucket id for a key: contiguous ranges partition the integer key space. */
  bucketOf(key: number): number {
    this.assertKey(key);
    const bucket = Math.floor((key / this.keySpaceSize) * this.bucketCount);
    return Math.min(bucket, this.bucketCount - 1);
  }

  set(key: number, value: Uint8Array): void {
    this.assertKey(key);
    this.entries.set(key, value);
    this.currentVersion++;
  }

  /** Delete by writing a tombstone; the key stays visible to sync. */
  delete(key: number): void {
    this.assertKey(key);
    this.entries.set(key, null);
    this.currentVersion++;
  }

  /** Live value lookup (tombstones read as undefined). */
  get(key: number): Uint8Array | undefined {
    const v = this.entries.get(key);
    return v === null ? undefined : v;
  }

  has(key: number): boolean {
    return this.entries.has(key);
  }

  /** Records of one bucket, sorted by key; tombstones included. */
  recordsInBucket(bucket: number): BucketRecord[] {
    const out: BucketRecord[] = [];
    for (const [key, value] of this.entries) {
      if (this.bucketOf(key) === bucket) out.push({ key, value });
    }
    out.sort((a, b) => a.key - b.key);
    return out;
  }

  /** Summary of every bucket; empty buckets get EMPTY_BUCKET_DIGEST + count 0. */
  summaries(): BucketSummary[] {
    const result: BucketSummary[] = [];
    for (let bucket = 0; bucket < this.bucketCount; bucket++) {
      const records = this.recordsInBucket(bucket);
      let digest = EMPTY_BUCKET_DIGEST;
      for (const rec of records) {
        digest = mix32(digest, rec.key >>> 0);
        const valueDigest =
          rec.value === null ? TOMBSTONE_MARKER : this.digestOf(rec.value);
        digest = mix32(digest, valueDigest);
      }
      result.push({ bucket, count: records.length, digest });
    }
    return result;
  }

  /** Apply remote records (upserts and tombstones) locally. */
  apply(records: BucketRecord[]): void {
    for (const rec of records) {
      this.entries.set(rec.key, rec.value === null ? null : rec.value);
      this.currentVersion++;
    }
  }

  /** Full live set (no tombstones) — used for final full-set comparison. */
  liveEntries(): Map<number, Uint8Array> {
    const out = new Map<number, Uint8Array>();
    for (const [key, value] of this.entries) {
      if (value !== null) out.set(key, value);
    }
    return out;
  }

  /** Keys currently carrying a tombstone. */
  tombstones(): Set<number> {
    const out = new Set<number>();
    for (const [key, value] of this.entries) {
      if (value === null) out.add(key);
    }
    return out;
  }

  private assertKey(key: number): void {
    if (!Number.isInteger(key) || key < 0 || key >= this.keySpaceSize) {
      throw new RangeError(`key ${key} outside [0, ${this.keySpaceSize})`);
    }
  }
}

/** Byte-by-byte equality of two values. */
export const bytesEqual = (a: Uint8Array, b: Uint8Array): boolean => {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
};

/** Record-by-record, byte-by-byte equality of two sorted bucket record lists. */
export const recordsEqual = (a: BucketRecord[], b: BucketRecord[]): boolean => {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    const ra = a[i]!;
    const rb = b[i]!;
    if (ra.key !== rb.key) return false;
    if (ra.value === null || rb.value === null) {
      if (ra.value !== rb.value) return false;
    } else if (!bytesEqual(ra.value, rb.value)) {
      return false;
    }
  }
  return true;
};
