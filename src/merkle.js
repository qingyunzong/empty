import { sha256hex } from './canon.js';

// Domain-separated Merkle tree over block hashes.
// Odd nodes at a level are promoted (not duplicated).
export function leafHash(blockHash) {
  return sha256hex('evpack:leaf:' + blockHash);
}

export function nodeHash(left, right) {
  return sha256hex('evpack:node:' + left + right);
}

export function emptyRoot() {
  return sha256hex('evpack:empty');
}

export function merkleRoot(blockHashes) {
  if (blockHashes.length === 0) return emptyRoot();
  let level = blockHashes.map(leafHash);
  while (level.length > 1) {
    const next = [];
    for (let i = 0; i < level.length; i += 2) {
      if (i + 1 < level.length) next.push(nodeHash(level[i], level[i + 1]));
      else next.push(level[i]);
    }
    level = next;
  }
  return level[0];
}

// Inclusion proof for blockHashes[index]; returns bottom-up sibling list.
export function prove(blockHashes, index) {
  const proof = [];
  let level = blockHashes.map(leafHash);
  let idx = index;
  while (level.length > 1) {
    const next = [];
    for (let i = 0; i < level.length; i += 2) {
      if (i + 1 < level.length) {
        if (i === idx) proof.push({ hash: level[i + 1], side: 'right' });
        else if (i + 1 === idx) proof.push({ hash: level[i], side: 'left' });
        next.push(nodeHash(level[i], level[i + 1]));
      } else {
        next.push(level[i]);
      }
    }
    idx = Math.floor(idx / 2);
    level = next;
  }
  return proof;
}

// Verify an inclusion proof. Needs index + total length to replay promotions.
export function verifyProof(blockHash, index, length, proof, root) {
  if (!Number.isInteger(index) || index < 0 || index >= length) return false;
  let acc = leafHash(blockHash);
  let idx = index;
  let len = length;
  let p = 0;
  while (len > 1) {
    if (idx % 2 === 1) {
      const step = proof[p++];
      if (!step || step.side !== 'left') return false;
      acc = nodeHash(step.hash, acc);
    } else if (idx + 1 < len) {
      const step = proof[p++];
      if (!step || step.side !== 'right') return false;
      acc = nodeHash(acc, step.hash);
    }
    idx = Math.floor(idx / 2);
    len = Math.ceil(len / 2);
  }
  if (p !== proof.length) return false;
  return acc === root;
}
