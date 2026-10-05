import { createHash, timingSafeEqual } from "node:crypto";

export const HASH_SIZE = 32;

const LEAF_PREFIX = Buffer.from([0x00]);
const NODE_PREFIX = Buffer.from([0x01]);

function sha256(...chunks: Uint8Array[]): Buffer {
  const h = createHash("sha256");
  for (const c of chunks) h.update(c);
  return h.digest();
}

export function leafHash(data: Uint8Array): Buffer {
  return sha256(LEAF_PREFIX, data);
}

export function innerHash(left: Uint8Array, right: Uint8Array): Buffer {
  return sha256(NODE_PREFIX, left, right);
}

/** Root of the empty tree: SHA-256 of the empty string (RFC 6962 §2.1). */
export const EMPTY_ROOT: Buffer = sha256();

function hashesEqual(a: Uint8Array, b: Uint8Array): boolean {
  return a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));
}

/** Largest power of two strictly smaller than n (n >= 2). */
function splitPoint(n: number): number {
  let k = 1;
  while ((k << 1) < n) k <<= 1;
  return k;
}

function mth(leafHashes: Uint8Array[]): Buffer {
  const n = leafHashes.length;
  if (n === 0) return Buffer.from(EMPTY_ROOT);
  if (n === 1) return Buffer.from(leafHashes[0]);
  const k = splitPoint(n);
  return innerHash(mth(leafHashes.slice(0, k)), mth(leafHashes.slice(k)));
}

/** Merkle Tree Hash of the given leaf data items. */
export function rootHash(leaves: Uint8Array[]): Buffer {
  return mth(leaves.map(leafHash));
}

function subproof(m: number, hashes: Uint8Array[]): Buffer[] {
  const n = hashes.length;
  // Base case: the first m leaves cover this whole subtree, so commit to it.
  // (Reaching this with the full tree means m === n, handled by the caller.)
  if (m === n) return [mth(hashes)];
  const k = splitPoint(n);
  if (m <= k) {
    return [...subproof(m, hashes.slice(0, k)), mth(hashes.slice(k))];
  }
  return [...subproof(m - k, hashes.slice(k)), mth(hashes.slice(0, k))];
}

/**
 * Consistency proof PROOF(m, D_n) (RFC 6962 §2.1.2): proves the tree with
 * the first m leaves is a prefix of the tree with all n leaves.
 * Empty proof when m === 0 or m === n. When m is a power of two, the first
 * proof node is the old root itself.
 */
export function consistencyProof(m: number, leaves: Uint8Array[]): Buffer[] {
  const n = leaves.length;
  if (!Number.isInteger(m) || m < 0 || m > n) {
    throw new RangeError(`invalid old size ${m} for tree of size ${n}`);
  }
  if (m === 0 || m === n) return [];
  return subproof(m, leaves.map(leafHash));
}

/**
 * Verifies a consistency proof given ONLY the two (size, root) digests and
 * the proof. Returns true iff the proof shows the old tree is a prefix of
 * the new tree.
 *
 * Empty-tree / equal-size rules:
 *  - oldSize > newSize: always false.
 *  - oldSize === newSize: valid iff proof is empty and roots are equal.
 *  - oldSize === 0 < newSize: valid iff proof is empty (the empty tree is a
 *    prefix of every tree).
 *  - 0 < oldSize < newSize: RFC 6962 §2.1.2 verification, proof non-empty.
 *
 * Note (RFC 6962 semantics): the security binding is on the two ROOTS. The
 * sizes drive the fn/sn index arithmetic, so the same (proof, roots) can
 * verify under a small range of size labels; a "wrong" label can never
 * correspond to a real tree of that size with the same root, so this does
 * not weaken append-only verification.
 */
export function verifyConsistency(
  oldSize: number,
  oldRoot: Uint8Array,
  newSize: number,
  newRoot: Uint8Array,
  proof: Uint8Array[],
): boolean {
  if (!Number.isInteger(oldSize) || !Number.isInteger(newSize)) return false;
  if (oldSize < 0 || newSize < 0) return false;
  if (oldRoot.length !== HASH_SIZE || newRoot.length !== HASH_SIZE) return false;
  if (proof.some((node) => node.length !== HASH_SIZE)) return false;
  if (oldSize > newSize) return false;
  if (oldSize === newSize) {
    return proof.length === 0 && hashesEqual(oldRoot, newRoot);
  }
  if (oldSize === 0) return proof.length === 0;
  if (proof.length === 0) return false;

  let fn = oldSize - 1;
  let sn = newSize - 1;
  while (fn & 1) {
    fn >>= 1;
    sn >>= 1;
  }

  let fr = Buffer.from(proof[0]);
  let sr = Buffer.from(proof[0]);
  for (let i = 1; i < proof.length; i++) {
    const c = proof[i];
    if (sn === 0) return false;
    if ((fn & 1) === 1 || fn === sn) {
      fr = innerHash(c, fr);
      sr = innerHash(c, sr);
      while ((fn & 1) === 0 && fn !== 0) {
        fn >>= 1;
        sn >>= 1;
      }
    } else {
      sr = innerHash(sr, c);
    }
    fn >>= 1;
    sn >>= 1;
  }
  return sn === 0 && hashesEqual(fr, oldRoot) && hashesEqual(sr, newRoot);
}

function auditPath(m: number, hashes: Uint8Array[]): Buffer[] {
  const n = hashes.length;
  if (n === 1) return [];
  const k = splitPoint(n);
  if (m < k) {
    return [...auditPath(m, hashes.slice(0, k)), mth(hashes.slice(k))];
  }
  return [...auditPath(m - k, hashes.slice(k)), mth(hashes.slice(0, k))];
}

/** Inclusion (audit) proof for the leaf at `index` (RFC 6962 §2.1.1). */
export function inclusionProof(index: number, leaves: Uint8Array[]): Buffer[] {
  const n = leaves.length;
  if (!Number.isInteger(index) || index < 0 || index >= n) {
    throw new RangeError(`invalid leaf index ${index} for tree of size ${n}`);
  }
  return auditPath(index, leaves.map(leafHash));
}

/** Verifies an inclusion proof for `leafData` at `leafIndex`. */
export function verifyInclusion(
  leafIndex: number,
  treeSize: number,
  leafData: Uint8Array,
  root: Uint8Array,
  proof: Uint8Array[],
): boolean {
  if (!Number.isInteger(leafIndex) || !Number.isInteger(treeSize)) return false;
  if (leafIndex < 0 || treeSize <= 0 || leafIndex >= treeSize) return false;
  if (root.length !== HASH_SIZE) return false;
  if (proof.some((node) => node.length !== HASH_SIZE)) return false;

  let fn = leafIndex;
  let sn = treeSize - 1;
  let r = leafHash(leafData);
  for (const p of proof) {
    if (sn === 0) return false;
    if ((fn & 1) === 1 || fn === sn) {
      r = innerHash(p, r);
      while ((fn & 1) === 0 && fn !== 0) {
        fn >>= 1;
        sn >>= 1;
      }
    } else {
      r = innerHash(r, p);
    }
    fn >>= 1;
    sn >>= 1;
  }
  return sn === 0 && hashesEqual(r, root);
}

/** An append-only log backed by a Merkle tree. */
export class AppendOnlyLog {
  private readonly leaves: Buffer[] = [];

  get size(): number {
    return this.leaves.length;
  }

  append(data: Uint8Array): number {
    this.leaves.push(Buffer.from(data));
    return this.leaves.length - 1;
  }

  root(): Buffer {
    return rootHash(this.leaves);
  }

  consistencyProof(oldSize: number): Buffer[] {
    return consistencyProof(oldSize, this.leaves);
  }

  inclusionProof(leafIndex: number): Buffer[] {
    return inclusionProof(leafIndex, this.leaves);
  }
}
