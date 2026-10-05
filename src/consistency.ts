import { MerkleTree, emptyTreeRoot, hashChildren, isPowerOfTwo, largestPowerOfTwoLessThan, HASH_SIZE } from "./merkle";

/**
 * Prefix-consistency proof (RFC 6962 section 2.1.2): proves the tree with
 * `firstSize` leaves is a prefix of the tree with `secondSize` leaves.
 *
 * Empty-tree / equal-tree rules (mirrored by the verifier):
 *  - firstSize === 0          -> empty proof; the empty tree is a prefix of every tree.
 *  - firstSize === secondSize -> empty proof; identical trees are trivially consistent.
 */
export function generateConsistencyProof(tree: MerkleTree, firstSize: number, secondSize: number = tree.size): Buffer[] {
  if (!Number.isInteger(firstSize) || !Number.isInteger(secondSize) || firstSize < 0 || secondSize < 0) {
    throw new RangeError("tree sizes must be non-negative integers");
  }
  if (firstSize > secondSize) {
    throw new RangeError(`first tree (${firstSize}) cannot be larger than second tree (${secondSize})`);
  }
  if (secondSize > tree.size) {
    throw new RangeError(`tree holds ${tree.size} leaves, cannot prove size ${secondSize}`);
  }
  if (firstSize === 0 || firstSize === secondSize) return [];
  return subproof(tree, firstSize, 0, secondSize, true);
}

function subproof(tree: MerkleTree, m: number, start: number, end: number, complete: boolean): Buffer[] {
  const width = end - start;
  if (m === width) {
    return complete ? [] : [tree.subtreeHash(start, end)];
  }
  const k = largestPowerOfTwoLessThan(width);
  if (m <= k) {
    return [...subproof(tree, m, start, start + k, complete), tree.subtreeHash(start + k, end)];
  }
  return [...subproof(tree, m - k, start + k, end, false), tree.subtreeHash(start, start + k)];
}

function isHash(value: unknown): value is Buffer {
  return Buffer.isBuffer(value) && value.length === HASH_SIZE;
}

/**
 * Verifies a prefix-consistency proof given ONLY the two tree sizes, the two
 * root hashes, and the proof (RFC 6962 section 2.1.4.2). Returns false on any
 * malformed input instead of throwing.
 */
export function verifyConsistencyProof(
  firstSize: number,
  secondSize: number,
  firstRoot: Buffer,
  secondRoot: Buffer,
  proof: Buffer[],
): boolean {
  if (!Number.isInteger(firstSize) || !Number.isInteger(secondSize)) return false;
  if (firstSize < 0 || secondSize < 0 || firstSize > secondSize) return false;
  if (!isHash(firstRoot) || !isHash(secondRoot)) return false;
  if (!Array.isArray(proof) || !proof.every(isHash)) return false;

  // Empty-tree rule: the empty tree is a prefix of every tree; the proof must
  // be empty and the first root must be the well-known empty-tree hash.
  if (firstSize === 0) {
    if (proof.length !== 0 || !firstRoot.equals(emptyTreeRoot())) return false;
    return secondSize === 0 ? secondRoot.equals(emptyTreeRoot()) : true;
  }
  // Equal-tree rule: identical sizes need an empty proof and equal roots.
  if (firstSize === secondSize) {
    return proof.length === 0 && firstRoot.equals(secondRoot);
  }
  if (proof.length === 0) return false;

  let fn = firstSize - 1;
  let sn = secondSize - 1;
  const nodes = [...proof];
  if (isPowerOfTwo(firstSize)) nodes.unshift(firstRoot);

  while (fn & 1) {
    fn >>= 1;
    sn >>= 1;
  }

  let fr = nodes[0]!;
  let sr = nodes[0]!;
  for (let i = 1; i < nodes.length; i++) {
    const c = nodes[i]!;
    if (sn === 0) return false; // proof longer than the tree allows
    if ((fn & 1) === 1 || fn === sn) {
      fr = hashChildren(c, fr);
      sr = hashChildren(c, sr);
      while ((fn & 1) === 0 && fn !== 0) {
        fn >>= 1;
        sn >>= 1;
      }
    } else {
      sr = hashChildren(sr, c);
    }
    fn >>= 1;
    sn >>= 1;
  }
  return sn === 0 && fr.equals(firstRoot) && sr.equals(secondRoot);
}
