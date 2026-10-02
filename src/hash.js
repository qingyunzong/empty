'use strict';

const { createHash } = require('node:crypto');

function sha256hex(data) {
  return createHash('sha256').update(data, 'utf8').digest('hex');
}

// Merkle tree over hex leaf hashes. Leaves are hashed once more to domain-
// separate leaf vs. internal nodes. Empty tree has a well-defined root.
const EMPTY_ROOT = sha256hex('audit-sampler/empty');

function leafHash(leafHex) {
  return sha256hex('leaf:' + leafHex);
}

function nodeHash(leftHex, rightHex) {
  return sha256hex('node:' + leftHex + rightHex);
}

function merkleRoot(leavesHex) {
  if (leavesHex.length === 0) return EMPTY_ROOT;
  let level = leavesHex.map(leafHash);
  while (level.length > 1) {
    const next = [];
    for (let i = 0; i < level.length; i += 2) {
      const left = level[i];
      const right = i + 1 < level.length ? level[i + 1] : level[i];
      next.push(nodeHash(left, right));
    }
    level = next;
  }
  return level[0];
}

// Proof for leaf at `index`: list of {position: 'left'|'right', hash} siblings.
function merkleProof(leavesHex, index) {
  if (index < 0 || index >= leavesHex.length) {
    throw new RangeError('merkleProof: index out of range');
  }
  const proof = [];
  let level = leavesHex.map(leafHash);
  let idx = index;
  while (level.length > 1) {
    const siblingIdx = idx % 2 === 0 ? idx + 1 : idx - 1;
    const sibling = siblingIdx < level.length ? level[siblingIdx] : level[idx];
    proof.push({
      position: idx % 2 === 0 ? 'right' : 'left',
      hash: sibling,
    });
    const next = [];
    for (let i = 0; i < level.length; i += 2) {
      const left = level[i];
      const right = i + 1 < level.length ? level[i + 1] : level[i];
      next.push(nodeHash(left, right));
    }
    idx = Math.floor(idx / 2);
    level = next;
  }
  return proof;
}

function verifyMerkleProof(leafHex, proof, expectedRoot) {
  let acc = leafHash(leafHex);
  for (const step of proof) {
    acc = step.position === 'right'
      ? nodeHash(acc, step.hash)
      : nodeHash(step.hash, acc);
  }
  return acc === expectedRoot;
}

module.exports = { sha256hex, merkleRoot, merkleProof, verifyMerkleProof, EMPTY_ROOT };
