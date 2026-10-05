import { createHash } from "node:crypto";
import { BUCKET_COUNT, BucketEntry, Store } from "./store";

export type HashFn = (data: Uint8Array) => Uint8Array;

export const sha256: HashFn = (data) => createHash("sha256").update(data).digest();

export interface BucketDigest {
  index: number;
  live: number;
  tombstones: number;
  hash: string;
}

function serializeBucket(index: number, entries: BucketEntry[]): Uint8Array {
  let size = 8;
  for (const entry of entries) {
    size += 8 + 1 + (entry.kind === "live" ? 4 + entry.value.length : 0);
  }
  const buffer = new ArrayBuffer(size);
  const view = new DataView(buffer);
  const bytes = new Uint8Array(buffer);
  let offset = 0;
  view.setBigInt64(offset, BigInt(index));
  offset += 8;
  for (const entry of entries) {
    view.setBigInt64(offset, BigInt(entry.key));
    offset += 8;
    view.setUint8(offset, entry.kind === "live" ? 1 : 0);
    offset += 1;
    if (entry.kind === "live") {
      view.setUint32(offset, entry.value.length);
      offset += 4;
      bytes.set(entry.value, offset);
      offset += entry.value.length;
    }
  }
  return bytes;
}

function toHex(bytes: Uint8Array): string {
  let out = "";
  for (const byte of bytes) out += byte.toString(16).padStart(2, "0");
  return out;
}

/**
 * Digest of one bucket. Tombstones are serialized into the hash and counted
 * separately, so a bucket holding only tombstones differs from a bucket that
 * has always been empty.
 */
export function digestOf(index: number, entries: BucketEntry[], hashFn: HashFn): BucketDigest {
  let live = 0;
  let tombstones = 0;
  for (const entry of entries) {
    if (entry.kind === "live") live++;
    else tombstones++;
  }
  return {
    index,
    live,
    tombstones,
    hash: toHex(hashFn(serializeBucket(index, entries))),
  };
}

export function digestsFor(
  store: Store,
  hashFn: HashFn,
  bucketCount: number = BUCKET_COUNT
): BucketDigest[] {
  const out: BucketDigest[] = [];
  for (let index = 0; index < bucketCount; index++) {
    out.push(digestOf(index, store.entriesInBucket(index, bucketCount), hashFn));
  }
  return out;
}

export function sameDigest(a: BucketDigest, b: BucketDigest): boolean {
  return a.hash === b.hash && a.live === b.live && a.tombstones === b.tombstones;
}
