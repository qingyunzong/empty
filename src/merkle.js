import { sha256 } from './util.js';

export function merkleRoot(leaves) {
  if (leaves.length === 0) return sha256('empty');
  let level = leaves.slice();
  while (level.length > 1) {
    const next = [];
    for (let i = 0; i < level.length; i += 2) {
      if (i + 1 < level.length) next.push(sha256('node', level[i], level[i + 1]));
      else next.push(level[i]);
    }
    level = next;
  }
  return level[0];
}

export function merkleProof(leaves, index) {
  const proof = [];
  let level = leaves.slice();
  let idx = index;
  while (level.length > 1) {
    const sibling = idx % 2 === 0 ? idx + 1 : idx - 1;
    if (sibling < level.length) {
      proof.push({ pos: idx % 2 === 0 ? 'R' : 'L', hash: level[sibling] });
    }
    const next = [];
    for (let i = 0; i < level.length; i += 2) {
      if (i + 1 < level.length) next.push(sha256('node', level[i], level[i + 1]));
      else next.push(level[i]);
    }
    level = next;
    idx = Math.floor(idx / 2);
  }
  return proof;
}

export function verifyProof(leaf, proof, root) {
  let acc = leaf;
  for (const step of proof) {
    acc = step.pos === 'R' ? sha256('node', acc, step.hash) : sha256('node', step.hash, acc);
  }
  return acc === root;
}
