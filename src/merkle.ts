import { createHash } from "node:crypto";

export const HASH_SIZE = 32;

const LEAF_PREFIX = Buffer.from([0x00]);
const NODE_PREFIX = Buffer.from([0x01]);

export function hashLeaf(data: Buffer): Buffer {
  return createHash("sha256").update(Buffer.concat([LEAF_PREFIX, data])).digest();
}

export function hashChildren(left: Buffer, right: Buffer): Buffer {
  return createHash("sha256").update(Buffer.concat([NODE_PREFIX, left, right])).digest();
}

export function emptyTreeRoot(): Buffer {
  return createHash("sha256").digest();
}

export function isPowerOfTwo(n: number): boolean {
  return n > 0 && (n & (n - 1)) === 0;
}

export function largestPowerOfTwoLessThan(n: number): number {
  if (!Number.isInteger(n) || n < 2) {
    throw new RangeError(`expected an integer >= 2, got ${n}`);
  }
  let k = 1;
  while ((k << 1) < n) k <<= 1;
  return k;
}

/**
 * Append-only Merkle tree over a log of opaque leaf payloads (RFC 6962
 * domain separation: 0x00 for leaves, 0x01 for interior nodes).
 */
export class MerkleTree {
  private readonly leaves: Buffer[] = [];

  append(data: Buffer | string): number {
    const leaf = typeof data === "string" ? Buffer.from(data, "utf8") : data;
    this.leaves.push(leaf);
    return this.leaves.length - 1;
  }

  get size(): number {
    return this.leaves.length;
  }

  /** Merkle tree hash of the leaf range [start, end). */
  subtreeHash(start: number, end: number): Buffer {
    if (start < 0 || end > this.leaves.length || start > end) {
      throw new RangeError(`invalid range [${start}, ${end}) for tree of size ${this.leaves.length}`);
    }
    const width = end - start;
    if (width === 0) return emptyTreeRoot();
    if (width === 1) return hashLeaf(this.leaves[start]!);
    const k = largestPowerOfTwoLessThan(width);
    return hashChildren(this.subtreeHash(start, start + k), this.subtreeHash(start + k, end));
  }

  /** Root hash of the prefix tree holding the first `size` leaves. */
  root(size: number = this.leaves.length): Buffer {
    return this.subtreeHash(0, size);
  }
}
