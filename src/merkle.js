import { nodeHash } from './hash.js';

// Merkle tree over hex leaf hashes. Odd levels duplicate the last node.
export function merkleRoot(leaves) {
  if (leaves.length === 0) return null;
  let level = leaves.slice();
  while (level.length > 1) {
    const next = [];
    for (let i = 0; i < level.length; i += 2) {
      const right = i + 1 < level.length ? level[i + 1] : level[i];
      next.push(nodeHash(level[i], right));
    }
    level = next;
  }
  return level[0];
}

// Authentication path for leaves[index]; each step records the sibling
// hash and the side on which it sits ('left' | 'right').
export function merkleProof(leaves, index) {
  if (!Number.isInteger(index) || index < 0 || index >= leaves.length) return null;
  const path = [];
  let level = leaves.slice();
  let idx = index;
  while (level.length > 1) {
    const isRight = idx % 2 === 1;
    const sib = isRight ? idx - 1 : (idx + 1 < level.length ? idx + 1 : idx);
    path.push({ hash: level[sib], side: isRight ? 'left' : 'right' });
    const next = [];
    for (let i = 0; i < level.length; i += 2) {
      const right = i + 1 < level.length ? level[i + 1] : level[i];
      next.push(nodeHash(level[i], right));
    }
    idx = Math.floor(idx / 2);
    level = next;
  }
  return { index, leaf: leaves[index], path, root: level[0] };
}

export function verifyProof(leaf, path, root) {
  let acc = leaf;
  for (const step of path) {
    acc = step.side === 'left' ? nodeHash(step.hash, acc) : nodeHash(acc, step.hash);
  }
  return acc === root;
}
