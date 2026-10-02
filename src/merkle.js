import { sha256hex } from './hash.js';

const leafTag = (blockHash) => sha256hex('evpack:leaf:' + blockHash);
const nodeTag = (left, right) => sha256hex('evpack:node:' + left + ':' + right);
// The leaf count is mixed into the root so a proof is bound to one exact tree
// size; otherwise identical paths could verify against different counts.
const rootTag = (count, top) => sha256hex('evpack:root:' + count + ':' + top);

export const EMPTY_ROOT = sha256hex('evpack:empty');

// Merkle root over block hashes. Odd levels duplicate the last node.
export function merkleRoot(blockHashes) {
  if (blockHashes.length === 0) return EMPTY_ROOT;
  let level = blockHashes.map(leafTag);
  while (level.length > 1) {
    const next = [];
    for (let i = 0; i < level.length; i += 2) {
      next.push(nodeTag(level[i], level[i + 1] ?? level[i]));
    }
    level = next;
  }
  return rootTag(blockHashes.length, level[0]);
}

// Inclusion proof for leaves[index]: ordered sibling hashes bottom-up.
export function merkleProof(blockHashes, index) {
  if (!Number.isInteger(index) || index < 0 || index >= blockHashes.length) {
    throw new RangeError(`index ${index} out of range (count=${blockHashes.length})`);
  }
  const proof = [];
  let level = blockHashes.map(leafTag);
  let idx = index;
  while (level.length > 1) {
    const isRightNode = idx % 2 === 1;
    const sibling = level[isRightNode ? idx - 1 : idx + 1] ?? level[idx];
    proof.push({ hash: sibling, side: isRightNode ? 'left' : 'right' });
    const next = [];
    for (let i = 0; i < level.length; i += 2) {
      next.push(nodeTag(level[i], level[i + 1] ?? level[i]));
    }
    level = next;
    idx = Math.floor(idx / 2);
  }
  return proof;
}

// Recompute the root from a leaf and its proof; true iff it matches `root`.
export function verifyMerkleProof({ blockHash, index, count, proof, root }) {
  if (!Number.isInteger(index) || !Number.isInteger(count)) return false;
  if (index < 0 || index >= count || count < 1) return false;
  if (!Array.isArray(proof)) return false;
  let hash = leafTag(blockHash);
  let idx = index;
  let levelSize = count;
  let consumed = 0;
  while (levelSize > 1) {
    const step = proof[consumed];
    if (!step || typeof step.hash !== 'string' || !/^[0-9a-f]{64}$/.test(step.hash)) return false;
    const isRightNode = idx % 2 === 1;
    const expectedSide = isRightNode ? 'left' : 'right';
    if (step.side !== expectedSide) return false;
    hash = isRightNode ? nodeTag(step.hash, hash) : nodeTag(hash, step.hash);
    idx = Math.floor(idx / 2);
    levelSize = Math.ceil(levelSize / 2);
    consumed += 1;
  }
  return consumed === proof.length && idx === 0 && rootTag(count, hash) === root;
}
