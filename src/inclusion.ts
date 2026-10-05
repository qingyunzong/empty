import { MerkleTree, hashChildren, hashLeaf, largestPowerOfTwoLessThan, HASH_SIZE } from "./merkle";

/**
 * Inclusion (audit-path) proof that leaf `index` is in the tree with `size`
 * leaves (RFC 6962 section 2.1.1). Included so tests can show such a proof is
 * NOT accepted as a prefix-consistency proof.
 */
export function generateInclusionProof(tree: MerkleTree, index: number, size: number = tree.size): Buffer[] {
  if (!Number.isInteger(index) || !Number.isInteger(size) || index < 0 || index >= size) {
    throw new RangeError(`invalid leaf index ${index} for tree size ${size}`);
  }
  if (size > tree.size) {
    throw new RangeError(`tree holds ${tree.size} leaves, cannot prove size ${size}`);
  }
  return auditPath(tree, index, 0, size);
}

function auditPath(tree: MerkleTree, index: number, start: number, end: number): Buffer[] {
  const width = end - start;
  if (width === 1) return [];
  const k = largestPowerOfTwoLessThan(width);
  if (index < k) {
    return [...auditPath(tree, index, start, start + k), tree.subtreeHash(start + k, end)];
  }
  return [...auditPath(tree, index - k, start + k, end), tree.subtreeHash(start, start + k)];
}

/** Verifies an inclusion proof (RFC 6962 section 2.1.3.2). */
export function verifyInclusionProof(
  leaf: Buffer,
  leafIndex: number,
  treeSize: number,
  root: Buffer,
  proof: Buffer[],
): boolean {
  if (!Number.isInteger(leafIndex) || !Number.isInteger(treeSize)) return false;
  if (treeSize <= 0 || leafIndex < 0 || leafIndex >= treeSize) return false;
  if (!Buffer.isBuffer(root) || root.length !== HASH_SIZE) return false;
  if (!Array.isArray(proof) || !proof.every((p) => Buffer.isBuffer(p) && p.length === HASH_SIZE)) return false;

  let fn = leafIndex;
  let sn = treeSize - 1;
  let r = hashLeaf(leaf);
  for (const p of proof) {
    if ((fn & 1) === 1 || fn === sn) {
      r = hashChildren(p, r);
      while ((fn & 1) === 0 && fn !== 0) {
        fn >>= 1;
        sn >>= 1;
      }
    } else {
      r = hashChildren(r, p);
    }
    fn >>= 1;
    sn >>= 1;
  }
  return sn === 0 && r.equals(root);
}
