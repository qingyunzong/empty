import {sha256hex, stable} from './util.js';

export function leafHash(obj) {
  return sha256hex('leaf:' + stable(obj));
}

function nodeHash(a, b) {
  return sha256hex('node:' + a + b);
}

export function merkleRoot(leaves) {
  if (leaves.length === 0) return sha256hex('leaf:empty');
  let level = leaves.slice();
  while (level.length > 1) {
    const next = [];
    for (let i = 0; i < level.length; i += 2) {
      next.push(nodeHash(level[i], i + 1 < level.length ? level[i + 1] : level[i]));
    }
    level = next;
  }
  return level[0];
}

export function inclusionProof(leaves, index) {
  const proof = [];
  let idx = index;
  let level = leaves.slice();
  while (level.length > 1) {
    const sib = idx % 2 === 0 ? idx + 1 : idx - 1;
    proof.push({
      position: idx % 2 === 0 ? 'right' : 'left',
      hash: sib < level.length ? level[sib] : level[idx],
    });
    const next = [];
    for (let i = 0; i < level.length; i += 2) {
      next.push(nodeHash(level[i], i + 1 < level.length ? level[i + 1] : level[i]));
    }
    level = next;
    idx = Math.floor(idx / 2);
  }
  return proof;
}

export function verifyInclusion(leafHashValue, proof, root) {
  let acc = leafHashValue;
  for (const step of proof) {
    acc = step.position === 'right' ? nodeHash(acc, step.hash) : nodeHash(step.hash, acc);
  }
  return acc === root;
}
